import { locations, validateDetails } from './core.js';
import { validateSettings } from './shared.js';
import { readBody, json } from './http.js';

export const apiRoutes = new Map([
  ['/api/state', 'GET'],
  ['/api/services', 'GET'],
  ['/api/settings', 'POST'],
  ['/api/scan', 'POST'],
  ['/api/stop', 'POST'],
  ['/api/book', 'POST'],
  ['/api/book-express', 'POST'],
  ['/api/release-arm', 'POST'],
  ['/api/express-start', 'POST'],
  ['/api/release-stop', 'POST'],
]);

const ids = locations.map((location) => location.id);

// Route handlers operate only on the browser's session, never on shared booking state.
export async function handleApi(req, res, path, session, services, work) {
  const { scanner, bookings, release } = session;
  const { settings } = session;
  if (req.method === 'GET' && path === '/api/services') return json(res, 200, await services());
  if (req.method === 'GET' && path === '/api/state')
    return json(res, 200, {
      sessionId: session.sessionId,
      locations,
      settings,
      scan: scanner.state,
      release: release.state,
    });
  if (req.method === 'POST' && path === '/api/settings') {
    const next = validateSettings(await readBody(req), ids);
    session.settings = next;
    return json(res, 200, next);
  }
  if (req.method === 'POST' && path === '/api/scan') {
    if (scanner.state.status === 'running')
      return json(res, 409, { error: 'A scan is already running.' });
    const selection = await readBody(req);
    let scanSettings = structuredClone(settings);
    if (selection.locationId !== undefined) {
      if (!ids.includes(selection.locationId)) throw Error('Choose a valid location.');
      if (!/^\d+$/.test(String(selection.serviceKey || ''))) throw Error('Choose a valid service.');
      scanSettings = validateSettings(
        {
          ...settings,
          enabled: [selection.locationId],
          scope: 'all',
          startDate: selection.startDate,
          endDate: selection.endDate,
        },
        ids,
      );
      scanSettings.serviceKey = String(selection.serviceKey);
    }
    const done = work.acquire('scan');
    try {
      scanner.start(scanSettings);
      scanner.task.then(done, done);
    } catch (error) {
      done();
      throw error;
    }
    return json(res, 202, { started: true });
  }
  if (req.method === 'POST' && path === '/api/stop') {
    await scanner.stop();
    return json(res, 200, { stopped: true });
  }
  if (req.method === 'POST' && ['/api/book', '/api/book-express'].includes(path)) {
    const { id, requestId, reviewedDetails, locationId, day, serviceKey } = await readBody(req);
    const reviewed = validateDetails(reviewedDetails || {});
    const result =
      path === '/api/book-express'
        ? await bookings.bookExpress({ locationId, day, serviceKey }, reviewed, requestId)
        : await bookings.book(
            scanner.state.slots.find((slot) => slot.id === id),
            reviewed,
            requestId,
          );
    return json(res, 200, result);
  }
  if (req.method === 'POST' && ['/api/release-arm', '/api/express-start'].includes(path)) {
    const { mode, releaseDay, releaseTime, targetDay, locationId, serviceKey, reviewedDetails } =
      await readBody(req);
    const reviewed = validateDetails(reviewedDetails || {});
    if (release.active())
      throw new Error('An appointment search is already running or scheduled. Stop it first.');
    session.cleanup();
    session.releaseSlot = work.acquire('release');
    try {
      return json(
        res,
        200,
        await release.arm(
          { mode, releaseDay, releaseTime, targetDay, locationId, serviceKey },
          reviewed,
        ),
      );
    } finally {
      session.cleanup();
    }
  }
  if (req.method === 'POST' && path === '/api/release-stop') {
    const result = release.stop();
    session.cleanup();
    return json(res, 200, result);
  }
  return json(res, 404, { error: 'Not found.' });
}
