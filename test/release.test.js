import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseBooking, releaseWindow } from '../src/release.js';
const details = { firstName: 'Test', lastName: 'User', phone: '8085550100' };
function setup() {
  let now = Date.parse('2099-01-05T15:59:00-10:00'),
    jobs = [],
    calls = [],
    slots = [];
  const api = {
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
    times: async (...args) => {
      calls.push(args);
      return slots;
    },
  };
  const booked = [];
  const bookings = {
    book: async (slot, person, id) => {
      booked.push({ slot, person, id });
      return { id: 'receipt', status: 'booked', message: 'Booked' };
    },
  };
  const r = new ReleaseBooking({
    bookings,
    api,
    now: () => now,
    schedule: (fn, delay) => {
      jobs.push({ fn, delay });
      return jobs.length;
    },
    unschedule: () => {},
  });
  return {
    r,
    api,
    bookings,
    booked,
    calls,
    jobs,
    setNow: (value) => (now = value),
    setSlots: (value) => (slots = value),
    arm: () =>
      r.arm(
        { releaseDay: '2099-01-05', targetDay: '2099-01-06', locationId: 'ala-moana' },
        details,
      ),
  };
}
test('release defaults to 4:14 PM HST and targets the next calendar day across year boundaries', () => {
  assert.deepEqual(releaseWindow('2099-12-31'), {
    start: Date.parse('2100-01-01T02:14:00Z') + 500,
    end: Date.parse('2100-01-01T02:19:00Z'),
    day: '2100-01-01',
  });
});
test('prepares before release, polls only target service/day, books earliest once', async () => {
  const t = setup();
  await t.arm();
  assert.equal(t.calls.length, 0);
  assert.equal(t.jobs[0].delay, 15 * 60000 + 500);
  t.setNow(releaseWindow('2099-01-05').start);
  await t.r.tick();
  assert.deepEqual(t.calls[0], ['ALAM', '146', '2099-01-06']);
  assert.equal(t.jobs.at(-1).delay, 500);
  const early = Date.parse('2099-01-06T08:00:00-10:00');
  t.setSlots([
    { epoch: early + 3600000, time: '9 AM' },
    { epoch: early, time: '8 AM' },
  ]);
  await t.r.tick();
  assert.equal(t.booked[0].slot.epoch, early);
  assert.equal(t.r.state.status, 'booked');
  await t.r.tick();
  assert.equal(t.booked.length, 1);
});
test('stops on failed or uncertain submission without retrying', async () => {
  for (const status of ['failed', 'unknown']) {
    const t = setup();
    await t.arm();
    t.setNow(releaseWindow('2099-01-05').start);
    t.setSlots([{ epoch: Date.parse('2099-01-06T08:00:00-10:00') }]);
    let calls = 0;
    t.bookings.book = async () => {
      calls++;
      return { status, message: 'Stop' };
    };
    await t.r.tick();
    await t.r.tick();
    assert.equal(calls, 1);
    assert.equal(t.r.state.status, status);
  }
});
test('stop during availability request prevents booking and stale timer cannot restart', async () => {
  const t = setup();
  await t.arm();
  t.setNow(releaseWindow('2099-01-05').start);
  let resolve;
  t.api.times = () => new Promise((r) => (resolve = r));
  const pending = t.r.tick();
  t.r.stop();
  resolve([{ epoch: Date.parse('2099-01-06T08:00:00-10:00') }]);
  await pending;
  await t.jobs[0].fn();
  assert.equal(t.booked.length, 0);
  assert.equal(t.r.state.status, 'stopped');
});
test('expired windows and read failures stop, and duplicate arms are rejected', async () => {
  const t = setup();
  await t.arm();
  await assert.rejects(t.arm(), /already armed/);
  t.setNow(releaseWindow('2099-01-05').end);
  await t.r.tick();
  assert.equal(t.r.state.status, 'expired');
  assert.equal(t.calls.length, 0);
  await assert.rejects(t.arm(), /ended/);
  const u = setup();
  await u.arm();
  u.setNow(releaseWindow('2099-01-05').start);
  u.api.times = async () => {
    throw Error('HTTP 429');
  };
  await u.r.tick();
  assert.equal(u.r.state.status, 'failed');
});

test('custom release time controls scheduling and rejects invalid times', async () => {
  const t = setup();
  await t.r.arm(
    {
      releaseDay: '2099-01-05',
      targetDay: '2099-01-06',
      releaseTime: '17:30',
      locationId: 'ala-moana',
    },
    details,
  );
  assert.equal(t.jobs[0].delay, 91 * 60000 + 500);
  assert.equal(t.r.state.releaseTime, '17:30');
  assert.equal(t.r.state.start, Date.parse('2099-01-05T17:30:00-10:00') + 500);
  const midnight = releaseWindow('2099-12-31', '23:58');
  assert.equal(midnight.end, Date.parse('2100-01-01T00:03:00-10:00'));
  assert.equal(midnight.day, '2100-01-01');
  for (const time of ['', null, '24:00', '16:60', '4:00', '16:00:00'])
    assert.throws(() => releaseWindow('2099-01-05', time), /release time/);
});

test('release starts today while searching an independently selected target date', async () => {
  const t = setup();
  await t.r.arm(
    {
      releaseDay: '2099-01-05',
      releaseTime: '16:14',
      targetDay: '2099-02-12',
      locationId: 'ala-moana',
    },
    details,
  );
  t.setNow(releaseWindow('2099-01-05').start);
  await t.r.tick();
  assert.deepEqual(t.calls[0], ['ALAM', '146', '2099-02-12']);
  assert.equal(t.r.state.day, '2099-02-12');
  const u = setup();
  await assert.rejects(
    u.r.arm(
      { releaseDay: '2099-01-06', targetDay: '2099-02-12', locationId: 'ala-moana' },
      details,
    ),
    /start today/,
  );
  await assert.rejects(
    u.r.arm(
      { releaseDay: '2099-01-05', targetDay: '2099-01-04', locationId: 'ala-moana' },
      details,
    ),
    /future appointment/,
  );
});

test('release waits through the 500 ms buffer before querying availability', async () => {
  const t = setup();
  await t.arm();
  const nominal = Date.parse('2099-01-05T16:14:00-10:00');
  t.setNow(nominal + 499);
  await t.r.tick();
  assert.equal(t.calls.length, 0);
  assert.equal(t.jobs.at(-1).delay, 1);
  t.setNow(nominal + 500);
  await t.r.tick();
  assert.equal(t.calls.length, 1);
});

test('release respects selected service instead of defaulting to motor vehicles', async () => {
  const t = setup();
  t.api.catalog = async () => ({
    ALAM: {
      location_id: 'ALAM',
      appt_available: 1,
      services: {
        235: {
          service_id: 235,
          service_name: 'Disability Parking Permits',
          service_type: 'MV',
          enable: 1,
          appt_enabled: 1,
          service_appt_available: 1,
        },
      },
    },
  });
  await t.r.arm(
    {
      releaseDay: '2099-01-05',
      targetDay: '2099-01-06',
      locationId: 'ala-moana',
      serviceKey: '235',
    },
    details,
  );
  t.setNow(releaseWindow('2099-01-05').start);
  await t.r.tick();
  assert.deepEqual(t.calls[0], ['ALAM', '235', '2099-01-06']);
});

test('release clears contact details after stopping and expiration', async () => {
  const t = setup();
  await t.arm();
  assert.ok(t.r.person);
  t.r.stop();
  assert.equal(t.r.person, undefined);
  await t.arm();
  t.setNow(t.r.state.end);
  await t.r.tick();
  assert.equal(t.r.person, undefined);
});
