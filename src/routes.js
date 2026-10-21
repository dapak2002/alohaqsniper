import { locations, validateDetails } from './core.js';
import { validateSettings } from './shared.js';
import { readBody, json } from './http.js';

const ids = locations.map((location) => location.id);

// Route handlers operate only on the browser's session, never on shared booking state.
export async function handleApi(req, res, path, session, services) {
  const { scanner, bookings, release } = session;
  const { settings } = session;
  if (req.method === 'GET' && path === '/api/services') return json(res, 200, await services());
  if (req.method === 'GET' && path === '/api/state')
    return json(res, 200, { locations, settings, scan: scanner.state, release: release.state });
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
    scanner.start(scanSettings);
    return json(res, 202, { started: true });
  }
  if (req.method === 'POST' && path === '/api/stop') {
    await scanner.stop();
    return json(res, 200, { stopped: true });
  }
  if (req.method === 'POST' && ['/api/book', '/api/book-express'].includes(path)) {
    const { id, requestId, reviewedDetails, locationId, day, serviceKey } = await readBody(req);
    const reviewed = validateDetails(reviewedDetails || {});
    if (path === '/api/book-express')
      return json(
        res,
        200,
        await bookings.bookExpress({ locationId, day, serviceKey }, reviewed, requestId),
      );
    return json(
      res,
      200,
      await bookings.book(
        scanner.state.slots.find((s) => s.id === id),
        reviewed,
        requestId,
      ),
    );
  }
  if (req.method === 'POST' && path === '/api/release-arm') {
    const { releaseDay, releaseTime, targetDay, locationId, serviceKey, reviewedDetails } =
      await readBody(req);
    const reviewed = validateDetails(reviewedDetails || {});
    return json(
      res,
      200,
      await release.arm({ releaseDay, releaseTime, targetDay, locationId, serviceKey }, reviewed),
    );
  }
  if (req.method === 'POST' && path === '/api/release-stop') return json(res, 200, release.stop());
  return json(res, 404, { error: 'Not found.' });
}
