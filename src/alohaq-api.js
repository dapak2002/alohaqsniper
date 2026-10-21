import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'https://alohaq.honolulu.gov/';
export const locationCodes = {
  'commercial-dl': 'CCDL',
  'kapalama-dl': 'KAPA',
  'kapolei-dl': 'KAPO',
  'koolau-dl': 'KOOL',
  'wahiawa-dl': 'WADL',
  'waianae-dl': 'WAIA',
  'ala-moana': 'ALAM',
  downtown: 'FSCH',
  kapalama: 'KSCH',
  'hawaii-kai': 'HKAI',
  pearlridge: 'PEAR',
  windward: 'WIND',
  kapolei: 'KAPS',
  wahiawa: 'WAHI',
  waianae: 'WAIS',
};
const DAY = 86400000;
export function parseDay(value) {
  const m = typeof value === 'string' && value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error('Unexpected availability date format.');
  const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso)
    throw new Error('Invalid availability date.');
  return iso;
}
export function timeSlot(day, value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value))
    throw new Error('Unexpected appointment time format.');
  const [h, m] = value.split(':');
  return {
    epoch: Date.parse(`${day}T${value}-10:00`),
    time: `${+h % 12 || 12}:${m} ${+h < 12 ? 'AM' : 'PM'} HST`,
  };
}
export function displayDate(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
// Match loadMaxDate() in AlohaQ's public custom_v3.js: extend the base
// maximum by each weekend/holiday encountered while walking to that maximum.
export function calendarLimit(start, base, holidays) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(base || '') ||
    !Number.isFinite(Date.parse(base)) ||
    new Date(base).toISOString().slice(0, 10) !== base
  )
    throw new Error('Location has no valid appointment horizon.');
  let cursor = Date.parse(start),
    end = Date.parse(base),
    steps = 0;
  while (cursor < end) {
    if (++steps > 2000) throw new Error('Unexpected appointment horizon.');
    cursor += DAY;
    const date = new Date(cursor);
    if (holidays.has(date.toISOString().slice(0, 10)) || [0, 6].includes(date.getUTCDay()))
      end += DAY;
  }
  return new Date(end).toISOString().slice(0, 10);
}
export function catalogServices(catalog, code) {
  const loc = catalog[code];
  if (!loc || loc.location_id !== code || !loc.services || typeof loc.services !== 'object')
    throw new Error(`Location ${code} missing from AlohaQ catalog.`);
  return Object.values(loc.services)
    .filter((s) => String(s.enable) === '1')
    .map((s) => {
      if (typeof s.service_name !== 'string' || !/^\d+$/.test(String(s.service_id)))
        throw new Error('Unexpected service catalog format.');
      return {
        key: String(s.service_id),
        type: s.service_type || '',
        directBooking:
          ['MV', 'USPP', 'US PP'].includes(s.service_type) ||
          (!s.service_type && /MOTOR VEHICLES.*Other Services/i.test(s.service_name)),
        name: s.service_name.replace(/\s+/g, ' ').trim(),
        disabled:
          Number(loc.appt_available) !== 1 ||
          Number(s.service_appt_available) !== 1 ||
          String(s.appt_enabled) !== '1',
      };
    });
}
export class AlohaQApi {
  constructor({ signal, fetchImpl = fetch, pause = sleep, spacing = 250 } = {}) {
    this.signal = signal;
    this.fetchImpl = fetchImpl;
    this.pause = pause;
    this.spacing = spacing;
    this.requests = 0;
  }
  async request(path, params, method = 'GET') {
    const url = new URL(path, BASE),
      fields = new URLSearchParams(params);
    if (method === 'GET') url.search = fields.toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      this.signal?.throwIfAborted();
      if (this.requests) await this.pause(this.spacing, undefined, { signal: this.signal });
      this.requests++;
      const signal = this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000);
      const response = await this.fetchImpl(url, {
        method,
        signal,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(method === 'POST' ? { body: fields.toString() } : {}),
      });
      if ([429, 502, 503, 504].includes(response.status) && attempt === 0) {
        const retry = response.headers.get('retry-after');
        const delay = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
          : 1500;
        if (!Number.isFinite(delay) || delay > 10000)
          throw new Error('AlohaQ requested a longer pause. Try again later.');
        await this.pause(Math.max(1000, delay), undefined, { signal: this.signal });
        continue;
      }
      if (!response.ok) throw new Error(`AlohaQ returned HTTP ${response.status}.`);
      try {
        return await response.json();
      } catch {
        throw new Error('AlohaQ returned a non-JSON response.');
      }
    }
  }
  async catalog() {
    const result = await this.request(
      'wrk_est_time_1.php',
      { category: '1', kiosk: 'false', locations: '' },
      'POST',
    );
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Unexpected location catalog response.');
    return result;
  }
  async holidays() {
    const result = await this.request('holidays.php', {}, 'POST');
    if (!Array.isArray(result)) throw new Error('Unexpected holiday response.');
    // Same citywide exception as the currently published AlohaQ client.
    return new Set(result.filter((day) => day !== '8/21/2026').map(parseDay));
  }
  async dates(code, service, start, end) {
    const result = await this.request('wrk_availability.php', {
      l: code,
      s: service,
      d: start,
      m: end,
      t: 'all',
    });
    if (result?.msg === 'none' && Array.isArray(result.data) && result.data.length === 0) return [];
    if (result?.msg !== 'success' || !Array.isArray(result.data))
      throw new Error('AlohaQ did not return a successful dates response.');
    return [...new Set(result.data.map(parseDay))]
      .filter((day) => day >= start && day <= end)
      .sort();
  }
  async times(code, service, day) {
    const result = await this.request('wrk_get_availability.php', { l: code, s: service, d: day });
    if (!Array.isArray(result)) throw new Error('Unexpected times response.');
    return [...new Set(result)]
      .map((time) => timeSlot(day, time))
      .sort((a, b) => a.epoch - b.epoch);
  }
}

export function selectBookingService(catalog, code, key) {
  const services = catalogServices(catalog, code);
  const service = key
    ? services.find((s) => s.key === String(key))
    : services.find((s) => /MOTOR VEHICLES.*Other Services/i.test(s.name));
  if (!service || service.disabled)
    throw new Error('This service is not available for appointments at this location.');
  if (!service.directBooking)
    throw new Error(
      'Complete this service’s eligibility and document steps on AlohaQ. Availability can still be scanned here.',
    );
  return service;
}
