// Approximate neighborhood coordinates; distances are straight-line miles,
// not driving distances. Update these if an office relocates.
export const locations = [
  { id: 'ala-moana', name: 'Ala Moana Satellite City Hall', lat: 21.291, lon: -157.843 },
  { id: 'downtown', name: 'Downtown Satellite City Hall', lat: 21.311, lon: -157.863 },
  { id: 'kapalama', name: 'Kapālama Satellite City Hall', lat: 21.322, lon: -157.872 },
  { id: 'hawaii-kai', name: 'Hawaii Kai Satellite City Hall', lat: 21.284, lon: -157.711 },
  { id: 'pearlridge', name: 'Pearlridge Satellite City Hall', lat: 21.385, lon: -157.941 },
  { id: 'windward', name: 'Windward City Satellite City Hall', lat: 21.405, lon: -157.799 },
  { id: 'kapolei', name: 'Kapolei Satellite City Hall', lat: 21.329, lon: -158.083 },
  { id: 'wahiawa', name: 'Wahiawa Satellite City Hall', lat: 21.503, lon: -158.023 },
  { id: 'waianae', name: 'Waianae Satellite City Hall', lat: 21.447, lon: -158.19 },
  { id: 'commercial-dl', name: 'Commercial Driver Licensing Center', lat: 21.404, lon: -157.973 },
  { id: 'kapalama-dl', name: 'Kapālama Driver Licensing Center', lat: 21.322, lon: -157.872 },
  { id: 'kapolei-dl', name: 'Kapolei Driver Licensing Center', lat: 21.329, lon: -158.083 },
  { id: 'koolau-dl', name: 'Koolau Driver Licensing Center', lat: 21.443, lon: -157.813 },
  { id: 'wahiawa-dl', name: 'Wahiawa Driver Licensing Center', lat: 21.503, lon: -158.023 },
  { id: 'waianae-dl', name: 'Waianae Driver Licensing Center', lat: 21.447, lon: -158.19 },
];
export function distance(a, b) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function origin(value) {
  const named = locations.find((l) => l.id === value);
  if (named) return named;
  const parts = value.split(',');
  const [lat, lon] = parts.map(Number);
  if (
    parts.length !== 2 ||
    parts.some((p) => !p.trim()) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    throw new Error('Origin must be a location ID or latitude,longitude.');
  return { lat, lon };
}
export function rankedLocations(ids, from) {
  const selected =
    ids === 'all'
      ? locations
      : ids.split(',').map((id) => {
          const loc = locations.find((l) => l.id === id.trim());
          if (!loc) throw new Error(`Unknown location: ${id}`);
          return loc;
        });
  return [...new Set(selected)]
    .map((l) => ({ ...l, miles: distance(from, l) }))
    .sort((a, b) => a.miles - b.miles);
}
export function slotEpoch(date, time) {
  const d = new Date(`${date} 00:00:00 GMT-1000`);
  const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!Number.isFinite(+d) || !m || +m[1] < 1 || +m[1] > 12 || +m[2] > 59)
    throw new Error(`Unrecognized slot: ${date} ${time}`);
  return +d + (((+m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + +m[2]) * 60000;
}
export function compareSlots() {
  return (a, b) => a.epoch - b.epoch || a.miles - b.miles;
}
export function validateDetails(value) {
  const firstName = String(value.firstName ?? '').trim();
  const lastName = String(value.lastName ?? '').trim();
  const phone = String(value.phone ?? '')
    .replace(/[\s()+.-]/g, '')
    .replace(/^1(?=\d{10}$)/, '');
  if (!firstName || !lastName || !/^\d{10}$/.test(phone))
    throw new Error('Enter first name, last name, and a 10-digit US phone number.');
  return { firstName, lastName, phone };
}
