export const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const serviceName = (name) => name.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
export function serviceLabel(name) {
  const clean = serviceName(name);
  if (/MOTOR VEHICLES.*Other Services/i.test(clean)) return 'Motor vehicles & other services';
  if (/U\.S\. PASSPORT/i.test(clean)) return 'U.S. passport — new applications';
  if (/DISABILITY PARKING/i.test(clean))
    return /HOLO/i.test(clean) ? 'Disability parking permits & HOLO' : 'Disability parking permits';
  return clean;
}
export function locationServiceSummary(services) {
  const labels = new Set();
  for (const service of services.filter((s) => !s.disabled)) {
    const name = service.name;
    if (/MOTOR VEHICLES/i.test(name)) labels.add('Motor vehicles');
    if (/PASSPORT/i.test(name)) labels.add('Passports');
    if (/DISABILITY PARKING/i.test(name)) labels.add('Disability parking');
    if (/HOLO/i.test(name)) labels.add('HOLO');
    if (/Commercial Driver|CDL/i.test(name)) labels.add('CDL');
    else if (/Driver.?s? License|Hawaii License|Provisional|Out Of State/i.test(name))
      labels.add('Driver license');
    if (/State (ID|Identification)/i.test(name)) labels.add('State ID');
    if (/Instruction Permit/i.test(name)) labels.add('Instruction permits');
    if (/Written Test/i.test(name)) labels.add('Written tests');
  }
  return labels.size
    ? [...labels].join(' · ')
    : services.some((s) => !s.disabled)
      ? 'Other services'
      : 'No online appointments';
}
export const dateLabel = (day) =>
  new Date(`${day}T12:00:00-10:00`).toLocaleDateString('en-US', {
    timeZone: 'Pacific/Honolulu',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
