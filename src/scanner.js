import { randomUUID } from 'node:crypto';
import {
  AlohaQApi,
  locationCodes,
  catalogServices,
  calendarLimit,
  displayDate,
} from './alohaq-api.js';
import { locations } from './core.js';
import { hstDay, scanRange } from './shared.js';

export class Scanner {
  constructor(onChange = () => {}, apiFactory = (options) => new AlohaQApi(options)) {
    this.apiFactory = apiFactory;
    this.onChange = onChange;
    this.state = {
      status: 'idle',
      slots: [],
      services: [],
      errors: [],
      message: 'Ready for your first scan.',
    };
    this.abort = null;
    this.cancelled = false;
  }
  emit() {
    this.onChange(this.state);
  }
  async stop() {
    if (this.state.status !== 'running') return;
    this.cancelled = true;
    this.abort?.abort();
  }
  start(settings) {
    if (this.state.status === 'running') throw new Error('A scan is already running.');
    const today = hstDay(Date.now());
    if (settings.endDate < today) throw new Error('End date must be today or later.');
    const range = scanRange(settings.startDate, settings.endDate);
    range.start = range.start < today ? today : range.start;
    this.cancelled = false;
    this.state = {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      range,
      settings: structuredClone(settings),
      slots: [],
      services: [],
      errors: [],
      datesScanned: 0,
      datesChecked: 0,
      datesTotal: 0,
      currentDay: null,
      locationsDone: 0,
      requests: 0,
      transport: 'api',
      message: 'Connecting to AlohaQ’s availability API…',
    };
    this.emit();
    this.task = this.run(settings);
  }
  async run(settings) {
    this.abort = new AbortController();
    const api = this.apiFactory({ signal: this.abort.signal });
    try {
      const catalog = await api.catalog();
      const holidays = await api.holidays();
      const ids = settings.order.filter((id) => settings.enabled.includes(id));
      for (const id of ids) {
        if (this.cancelled) break;
        const location = locations.find((l) => l.id === id),
          code = locationCodes[id];
        let services, end;
        try {
          services = catalogServices(catalog, code);
          end = [
            this.state.range.end,
            calendarLimit(hstDay(Date.now()), catalog[code].max_appt_date, holidays),
          ].sort()[0];
        } catch (e) {
          this.error(location, null, e);
          this.state.locationsDone++;
          continue;
        }
        for (const service of services) {
          if (this.cancelled) break;
          if (settings.serviceKey && service.key !== settings.serviceKey) continue;
          if (settings.scope === 'motor' && !/MOTOR VEHICLES.*Other Services/i.test(service.name))
            continue;
          const entry = {
            locationId: id,
            location: location.name,
            service: service.name,
            serviceKey: service.key,
            status: service.disabled ? 'unavailable' : 'pending',
            count: 0,
            through: end,
          };
          this.state.services.push(entry);
          this.emit();
          if (service.disabled) continue;
          const days = [];
          for (
            let timestamp = Date.parse(this.state.range.start);
            timestamp <= Date.parse(end);
            timestamp += 86400000
          ) {
            days.push(new Date(timestamp).toISOString().slice(0, 10));
          }
          this.state.datesTotal += days.length;
          let hadErrors = false;
          for (const day of days) {
            if (this.cancelled) break;
            const date = displayDate(day);
            this.state.currentDay = day;
            this.state.message = `Checking ${date} · ${location.name} · ${service.name}`;
            this.emit();
            try {
              // Query each day directly: AlohaQ's date index can omit days with times.
              const times = await api.times(code, service.key, day);
              if (this.cancelled) break;
              for (const { epoch, time } of times) {
                if (epoch <= Date.now() || epoch > this.state.range.cutoff || hstDay(epoch) !== day)
                  continue;
                this.state.slots.push({
                  id: randomUUID(),
                  locationId: id,
                  location: location.name,
                  service: service.name,
                  serviceKey: service.key,
                  directBooking: service.directBooking,
                  date,
                  day,
                  time,
                  epoch,
                  observedAt: Date.now(),
                });
                entry.count++;
              }
              this.state.datesScanned++;
            } catch (error) {
              if (this.cancelled) break;
              hadErrors = true;
              this.error(location, service, new Error(`${date}: ${error.message}`));
              if (error.status === 429) break;
            }
            this.state.datesChecked++;
            this.state.requests = api.requests;
            this.emit();
          }
          entry.status = this.cancelled || hadErrors ? 'partial' : 'complete';
          this.state.requests = api.requests;
          this.emit();
        }
        this.state.locationsDone++;
        this.emit();
      }
      this.state.status = this.cancelled
        ? 'cancelled'
        : this.state.errors.length
          ? 'partial'
          : 'complete';
      this.state.message = this.cancelled
        ? 'Scan stopped. Collected openings are kept.'
        : this.state.errors.length
          ? 'API scan finished with gaps. Review scan coverage below.'
          : 'API scan complete for the selected locations, services and date range.';
    } catch (e) {
      this.state.status = this.cancelled ? 'cancelled' : 'error';
      this.state.message = this.cancelled
        ? 'Scan stopped.'
        : `API scan failed: ${e.message.split('\n')[0]}`;
    } finally {
      this.abort = null;
      this.state.requests = api.requests;
      this.state.finishedAt = Date.now();
      this.emit();
    }
  }
  error(location, service, error) {
    this.state.errors.push({
      location: location.name,
      service: service?.name || 'Service discovery',
      message: error.message.split('\n')[0],
    });
    this.emit();
  }
}
