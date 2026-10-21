export const hstDay = (epoch) => new Date(epoch - 10 * 3600000).toISOString().slice(0, 10);
export function sortAppointments(slots, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...slots].sort(
    (a, b) =>
      a.epoch - b.epoch ||
      (rank.get(a.locationId) ?? 999) - (rank.get(b.locationId) ?? 999) ||
      a.service.localeCompare(b.service),
  );
}
export function validateSettings(value, ids) {
  if (
    !value ||
    !Array.isArray(value.order) ||
    value.order.length !== ids.length ||
    new Set(value.order).size !== ids.length ||
    value.order.some((id) => !ids.includes(id))
  )
    throw new Error('Location order must contain each location exactly once.');
  if (
    !Array.isArray(value.enabled) ||
    !value.enabled.length ||
    value.enabled.some((id) => !ids.includes(id))
  )
    throw new Error('Select at least one location.');
  if (!['all', 'motor'].includes(value.scope)) throw new Error('Invalid service scope.');
  scanRange(value.startDate, value.endDate);
  return {
    order: [...value.order],
    enabled: [...new Set(value.enabled)],
    scope: value.scope,
    startDate: value.startDate,
    endDate: value.endDate,
  };
}
export function scanRange(start, end) {
  for (const day of [start, end]) {
    if (
      typeof day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      throw new Error('Choose valid start and end dates.');
  }
  if (end < start) throw new Error('End date must be on or after start date.');
  return { start, end, cutoff: Date.parse(`${end}T23:59:59-10:00`) };
}
export function migrateSettings(value, now = Date.now()) {
  if (value.startDate !== undefined || value.endDate !== undefined) return value;
  const days = [30, 90, 180].includes(value.days) ? value.days : 90;
  const { days: oldDays, ...rest } = value;
  return { ...rest, startDate: hstDay(now), endDate: hstDay(now + (days - 1) * 86400000) };
}

export function releaseWindow(day, time = '16:14') {
  scanRange(day, day);
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error('Choose a valid release time.');
  const start = Date.parse(`${day}T${time}:00-10:00`);
  // Let the release settle before the first check; keep the original five-minute cutoff.
  return { start: start + 500, end: start + 5 * 60000, day: hstDay(start + 86400000) };
}
