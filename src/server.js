import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { RateLimits, WorkLimits, cached, limitedFetch } from './limits.js';
import { passwordAccess, clientAddress } from './access.js';
import { json } from './http.js';
import { apiRoutes, handleApi } from './routes.js';
import { Sessions } from './sessions.js';
import { readFile } from 'node:fs/promises';
import { locations } from './core.js';
import { validateSettings, migrateSettings } from './shared.js';
import { Scanner } from './scanner.js';
import { Bookings, appointmentRequest } from './bookings.js';
import { ReleaseBooking } from './release.js';
import { AlohaQApi, catalogServices, locationCodes } from './alohaq-api.js';

const root = new URL('../', import.meta.url);
const port = Number(process.env.PORT || 4317);
const address = `http://127.0.0.1:${port}`;
const ids = locations.map((l) => l.id);
const defaults = { order: ids, enabled: ids, scope: 'all', days: 90 };
const publicOrigins = [
  process.env.APP_ORIGIN,
  process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`,
]
  .filter(Boolean)
  .map((value) => new URL(value).origin);
const origins = new Set([...publicOrigins, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const hosts = new Set([...origins].map((origin) => new URL(origin).host));
const bindHost =
  process.env.HOST || (process.env.PORT || publicOrigins.length ? '0.0.0.0' : '127.0.0.1');
const rates = new RateLimits();
const work = new WorkLimits();
const upstreamFetch = limitedFetch();
const makeApi = (options) => new AlohaQApi({ ...options, fetchImpl: upstreamFetch });
const allowed = passwordAccess(process.env.APP_PASSWORD);
const trustedHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(trustedHops) || trustedHops < 0 || trustedHops > 5)
  throw Error('Invalid TRUST_PROXY_HOPS.');
const sessions = new Sessions(() => {
  const scanner = new Scanner(undefined, makeApi);
  const bookings = new Bookings({
    retainDetails: false,
    acquire: () => work.acquire('booking'),
    availability: makeApi(),
    request: (path, params, method) => appointmentRequest(path, params, method, upstreamFetch),
  });
  const release = new ReleaseBooking({ bookings, api: makeApi({ spacing: 0 }) });
  return {
    sessionId: randomUUID(),
    settings: validateSettings(migrateSettings(structuredClone(defaults)), ids),
    scanner,
    bookings,
    release,
    busy: () => scanner.state.status === 'running' || bookings.busy || release.active(),
    cleanup() {
      if (!release.active() && this.releaseSlot) {
        this.releaseSlot();
        this.releaseSlot = undefined;
      }
    },
    dispose() {
      bookings.records.length = 0;
      release.person = undefined;
      this.cleanup();
    },
  };
});
const sweep = setInterval(() => sessions.cleanup(), 1000);
sweep.unref();
const catalogApi = makeApi();
const services = cached(async () => {
  const catalog = await catalogApi.catalog();
  return {
    at: Date.now(),
    locations: locations.map((location) => ({
      ...location,
      services: catalogServices(catalog, locationCodes[location.id]),
    })),
  };
});
const files = {
  '/presentation.js': ['web/presentation.js', 'text/javascript'],
  '/': ['web/index.html', 'text/html'],
  '/express': ['web/express.html', 'text/html'],
  '/app.js': ['web/app.js', 'text/javascript'],
  '/assets/alohaq-sniper-logo.png': ['web/assets/alohaq-sniper-logo.png', 'image/png'],
  '/assets/favicon.png': ['web/assets/favicon.png', 'image/png'],
  '/style.css': ['web/style.css', 'text/css'],
  '/shared.js': ['src/shared.js', 'text/javascript'],
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, address);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Invalid host.' });
    if (
      req.method === 'POST' &&
      (!origins.has(req.headers.origin) || new URL(req.headers.origin).host !== req.headers.host)
    )
      return json(res, 403, { error: 'Use this site to make changes.' });
    if (!allowed(req.headers.authorization)) {
      rates.check(`auth:${clientAddress(req, trustedHops)}`, 10);
      res.setHeader('WWW-Authenticate', 'Basic realm="AlohaQ SNIPER", charset="UTF-8"');
      return json(res, 401, { error: 'Access password required.' });
    }
    if (url.pathname.startsWith('/api/')) {
      const method = apiRoutes.get(url.pathname);
      if (!method) return json(res, 404, { error: 'Not found.' });
      if (method !== req.method) return json(res, 405, { error: 'Method not allowed.' });
      const peer = clientAddress(req, trustedHops);
      rates.check(`requests:${peer}`, 1200);
      if (req.method === 'POST' && !['/api/stop', '/api/release-stop'].includes(url.pathname)) {
        rates.check(`writes:${peer}`, 30);
        if (
          ['/api/book', '/api/book-express', '/api/release-arm', '/api/express-start'].includes(
            url.pathname,
          )
        )
          rates.check(`booking:${peer}`, 10);
      }

      const current = sessions.get(
        req.headers.cookie,
        publicOrigins.some((origin) => new URL(origin).host === req.headers.host),
        {
          create: url.pathname === '/api/state',
          beforeCreate: () => {
            rates.check(`sessions:${peer}`, 10);
            rates.check('sessions:global', 100);
          },
        },
      );
      if (current.cookie) res.setHeader('Set-Cookie', current.cookie);
      if (req.method === 'POST' && !['/api/stop', '/api/release-stop'].includes(url.pathname))
        rates.check(current.value, 20);
      return await handleApi(req, res, url.pathname, current.value, services, work);
    }
    if (req.method === 'GET' && Object.hasOwn(files, url.pathname)) {
      const [file, type] = files[url.pathname];
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      });
      return res.end(await readFile(new URL(file, root)));
    }
    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
    json(res, e.status || 400, { error: e.message.split('\n')[0] });
  }
});
server.listen(port, bindHost, () => console.log(`AlohaQ calendar: ${address}`));
async function shutdown() {
  clearInterval(sweep);
  server.close();
  await Promise.all(
    [...sessions.entries.values()].map(async ({ value: { scanner, release } }) => {
      if (release.state.status !== 'submitting') release.stop();
      await scanner.stop();
      await scanner.task;
    }),
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
