import test from 'node:test';
import assert from 'node:assert/strict';
import { Bookings } from '../src/bookings.js';
const details = { firstName: 'Test', lastName: 'User', phone: '8085550100' };
const slot = {
  id: 'test-slot',
  locationId: 'ala-moana',
  location: 'Ala Moana',
  serviceKey: '146',
  service: 'Motor Vehicles & Other Services',
  day: '2027-01-01',
  date: 'January 1, 2027',
  time: '9:00 AM HST',
  epoch: Date.now() + 86400000,
};
const requestId = 'test-booking-0000001';
function create(request, save = async () => {}) {
  return new Bookings({
    request,
    save,
    availability: {
      catalog: async () => ({
        ALAM: {
          location_id: 'ALAM',
          appt_available: 1,
          services: {
            146: {
              service_id: 146,
              service_name: slot.service,
              service_type: 'MV',
              enable: 1,
              appt_enabled: 1,
              service_appt_available: 1,
            },
          },
        },
      }),
      times: async () => [{ epoch: slot.epoch }],
    },
  });
}
test('booking sends saved details once and stores confirmation; repeated request is idempotent', async () => {
  let count = 0;
  const b = create(async (path, body) => {
    count++;
    assert.equal(path, 'wrk_book_appointment.php');
    assert.equal(body.d, 'false');
    assert.equal(body.k, '0');
    assert.equal(body.m, details.phone);
    assert.equal(body.s, '146');
    return { success: '1', confirmation: 'TEST-ONLY' };
  });
  const record = await b.book(slot, details, requestId);
  assert.equal(record.status, 'booked');
  assert.equal((await b.book(slot, details, requestId)).confirmation, 'TEST-ONLY');
  assert.equal(count, 1);
});
test('cancellation targets only the recorded confirmation and is idempotent', async () => {
  let cancellations = 0;
  const b = create(async (path, body) => {
    if (path === 'wrk_book_appointment.php') return { success: 1, confirmation: 'TEST-ONLY' };
    cancellations++;
    assert.equal(body.q, 'TEST-ONLY');
    assert.equal(body.ln, 'User');
    return { success: 1 };
  });
  const r = await b.book(slot, details, requestId);
  assert.equal((await b.cancel(r.id)).status, 'cancelled');
  await b.cancel(r.id);
  assert.equal(cancellations, 1);
});
test('timeout is persisted as unknown; same request is never retried', async () => {
  let count = 0;
  const snapshots = [];
  const b = create(
    async () => {
      count++;
      throw Error('timeout');
    },
    async (records) => snapshots.push(structuredClone(records)),
  );
  const r = await b.book(slot, details, requestId);
  assert.equal(r.status, 'unknown');
  assert.equal(snapshots[0][0].status, 'submitting');
  await b.book(slot, details, requestId);
  assert.equal(count, 1);
  await b.book(slot, details, 'different-request-01');
  assert.equal(count, 2);
});
test('existing appointment response never requests replacement', async () => {
  const b = create(async (path, body) => {
    assert.equal(body.d, 'false');
    return { success: 2, count: 1 };
  });
  assert.equal((await b.book(slot, details, requestId)).status, 'failed');
});
test('stale availability and failed pre-submission persistence do not book', async () => {
  let calls = 0;
  const b = create(
    async () => {
      calls++;
    },
    async () => {
      throw Error('disk full');
    },
  );
  await assert.rejects(b.book(slot, details, requestId), /disk full/);
  assert.equal(calls, 0);
  assert.equal(b.records.length, 0);
  b.availability.times = async () => [];
  await assert.rejects(b.book(slot, details, requestId), /no longer available/);
  assert.equal(calls, 0);
});
test('uncertain cancellation can be reconciled without repeating a mutation', async () => {
  const b = create(async (path) => {
    if (path === 'wrk_book_appointment.php') return { success: 1, confirmation: 'TEST-ONLY' };
    if (path === 'wrk_cancel_appointment.php') throw Error('timeout');
    return { success: 0, message: 'Ticket expired or not found' };
  });
  const r = await b.book(slot, details, requestId);
  assert.equal((await b.cancel(r.id)).status, 'cancel_unknown');
  assert.equal((await b.verify(r.id)).status, 'inactive');
});
test('startup preserves unresolved submissions and blocks concurrent booking', async () => {
  const b = new Bookings({ records: [{ status: 'submitting' }] });
  assert.equal(b.records[0].status, 'unknown');
  const busy = create(async () => {});
  busy.busy = true;
  await assert.rejects(busy.book(slot, details, requestId), /in progress/);
});

test('express books earliest live time on exact day and location, once', async () => {
  const day = '2099-01-05',
    early = Date.parse(day + 'T09:00:00-10:00'),
    late = early + 3600000;
  let submissions = 0,
    reads = 0;
  const availability = {
    catalog: async () => ({
      WAHI: {
        location_id: 'WAHI',
        appt_available: 1,
        services: {
          95: {
            service_id: 95,
            service_name: 'Motor Vehicles & Other Services',
            enable: 1,
            service_appt_available: 1,
            appt_enabled: 1,
          },
        },
      },
    }),
    dates: async (code, service, start, end) => {
      assert.deepEqual([code, service, start, end], ['WAHI', '95', day, day]);
      return [day];
    },
    times: async (code, service, date) => {
      reads++;
      assert.deepEqual([code, service, date], ['WAHI', '95', day]);
      return [
        { epoch: late, time: '10:00 AM HST' },
        { epoch: early, time: '9:00 AM HST' },
        { epoch: early - 86400000, time: '9:00 AM HST' },
      ];
    },
  };
  const b = new Bookings({
    availability,
    request: async (path, body) => {
      submissions++;
      assert.equal(body.a, day + ' 09:00:00');
      assert.equal(body.l, 'WAHI');
      return { success: 1, confirmation: 'TEST-EXPRESS' };
    },
  });
  const r = await b.bookExpress({ locationId: 'wahiawa', day }, details, requestId);
  assert.equal(r.slot.epoch, early);
  assert.equal(r.slot.locationId, 'wahiawa');
  await b.bookExpress({ locationId: 'wahiawa', day }, details, requestId);
  assert.equal(submissions, 1);
  assert.equal(reads, 1);
});
test('express does not book or fall back when selected day has no remaining times', async () => {
  let submissions = 0;
  const b = new Bookings({
    availability: {
      catalog: async () => ({
        ALAM: {
          location_id: 'ALAM',
          appt_available: 1,
          services: {
            146: {
              service_id: 146,
              service_name: 'Motor Vehicles & Other Services',
              enable: 1,
              service_appt_available: 1,
              appt_enabled: 1,
            },
          },
        },
      }),
      dates: async () => ['2099-01-05'],
      times: async () => [],
    },
    request: async () => {
      submissions++;
    },
  });
  await assert.rejects(
    b.bookExpress({ locationId: 'ala-moana', day: '2099-01-05' }, details, requestId),
    /No appointments/,
  );
  b.availability.dates = async () => [];
  b.availability.times = async () => {
    throw Error('should not query times');
  };
  await assert.rejects(
    b.bookExpress({ locationId: 'ala-moana', day: '2099-01-05' }, details, requestId),
    /No appointments/,
  );
  await assert.rejects(
    b.bookExpress({ locationId: 'ala-moana', day: '2026-02-30' }, details, requestId),
  );
  assert.equal(submissions, 0);
  assert.equal(b.records.length, 0);
  assert.equal(b.busy, false);
});

for (const status of ['booked', 'unknown', 'submitting', 'cancel_unknown']) {
  test(`cached ${status} record does not block a new booking; AlohaQ decides`, async () => {
    let calls = 0;
    const b = create(async (path, body) => {
      calls++;
      assert.equal(body.d, 'false');
      return calls === 1 ? { success: 2 } : { success: 1, confirmation: 'NEW-TEST' };
    });
    b.records.push({ id: 'old', requestId: 'older-request-00001', status });
    const rejected = await b.book(slot, details, requestId);
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.message, /AlohaQ says you already have/);
    const accepted = await b.book(slot, details, 'new-attempt-0000001');
    assert.equal(accepted.status, 'booked');
    assert.equal(calls, 2);
  });
}
test('checking an externally cancelled ticket updates the cached booked record', async () => {
  const b = create(async () => ({ success: 0, message: 'Ticket expired or not found' }));
  b.records.push({ id: 'old', status: 'booked', confirmation: 'TEST', details });
  assert.equal((await b.verify('old')).status, 'inactive');
});

test('express uses the selected passport service and rejects eligibility services before mutation', async () => {
  const day = '2099-01-05',
    epoch = Date.parse(day + 'T09:00:00-10:00');
  let submits = 0;
  const b = new Bookings({
    availability: {
      catalog: async () => ({
        ALAM: {
          location_id: 'ALAM',
          appt_available: 1,
          services: {
            265: {
              service_id: 265,
              service_name: 'U.S. PASSPORT',
              service_type: 'US PP',
              enable: 1,
              appt_enabled: 1,
              service_appt_available: 1,
            },
            300: {
              service_id: 300,
              service_name: 'License Renewal',
              service_type: 'DL RNW',
              enable: 1,
              appt_enabled: 1,
              service_appt_available: 1,
            },
          },
        },
      }),
      dates: async (code, key) => {
        assert.equal(key, '265');
        return [day];
      },
      times: async (code, key) => {
        assert.equal(key, '265');
        return [{ epoch, time: '9:00 AM HST' }];
      },
    },
    request: async (path, body) => {
      submits++;
      assert.equal(body.s, '265');
      return { success: 1, confirmation: 'TEST' };
    },
  });
  await assert.rejects(
    b.bookExpress({ day, locationId: 'ala-moana', serviceKey: '300' }, details, requestId),
    /eligibility/,
  );
  await assert.rejects(
    b.bookExpress({ day, locationId: 'ala-moana', serviceKey: '999' }, details, requestId),
    /not available/,
  );
  const result = await b.bookExpress(
    { day, locationId: 'ala-moana', serviceKey: '265' },
    details,
    requestId,
  );
  assert.equal(result.slot.service, 'U.S. PASSPORT');
  assert.equal(submits, 1);
});

test('web booking discards contact details but retains retry deduplication', async () => {
  let calls = 0;
  const b = create(async () => {
    calls++;
    return { success: 1, confirmation: 'TEST' };
  });
  b.retainDetails = false;
  const result = await b.book(slot, details, requestId);
  assert.equal(result.details, undefined);
  assert.equal(b.records[0].details, undefined);
  await b.book(slot, details, requestId);
  assert.equal(calls, 1);
});
test('web booking clears details on unknown outcomes and bounds records', async () => {
  const b = create(async () => {
    throw Error('timeout');
  });
  b.retainDetails = false;
  b.maxRecords = 1;
  const result = await b.book(slot, details, requestId);
  assert.equal(result.status, 'unknown');
  assert.equal(result.details, undefined);
  await assert.rejects(b.book(slot, details, 'another-request-0001'), /limit reached/);
  assert.equal((await b.book(slot, details, requestId)).status, 'unknown');
});
