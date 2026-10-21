import http from 'node:http';
import { json } from './http.js';
import { handleApi } from './routes.js';
import { Sessions } from './sessions.js';
import { readFile } from 'node:fs/promises';
import { locations } from './core.js';
import { validateSettings, migrateSettings } from './shared.js';
import { Scanner } from './scanner.js';
import { Bookings } from './bookings.js';
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
const sessions = new Sessions(() => {
  const scanner = new Scanner(),
    bookings = new Bookings();
  const release = new ReleaseBooking({ bookings, api: new AlohaQApi({ spacing: 0 }) });
  return {
    settings: validateSettings(migrateSettings(structuredClone(defaults)), ids),
    scanner,
    bookings,
    release,
    busy: () => scanner.state.status === 'running' || bookings.busy || release.active(),
  };
});
const catalogApi = new AlohaQApi();
let serviceCatalog;
async function services() {
  if (!serviceCatalog || Date.now() - serviceCatalog.at > 60000) {
    const catalog = await catalogApi.catalog();
    serviceCatalog = {
      at: Date.now(),
      locations: locations.map((l) => ({
        ...l,
        services: catalogServices(catalog, locationCodes[l.id]),
      })),
    };
  }
  return serviceCatalog;
}
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
    if (url.pathname.startsWith('/api/')) {
      const current = sessions.get(
        req.headers.cookie,
        publicOrigins.some((origin) => new URL(origin).host === req.headers.host),
      );
      if (current.cookie) res.setHeader('Set-Cookie', current.cookie);
      return await handleApi(req, res, url.pathname, current.value, services);
    }
    if (req.method === 'GET' && files[url.pathname]) {
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
    json(res, 400, { error: e.message.split('\n')[0] });
  }
});
server.listen(port, bindHost, () => console.log(`AlohaQ calendar: ${address}`));
async function shutdown() {
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
