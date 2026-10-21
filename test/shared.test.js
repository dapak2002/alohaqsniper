import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortAppointments,
  hstDay,
  scanRange,
  validateSettings,
  migrateSettings,
} from '../src/shared.js';

const ids = ['ala-moana', 'downtown', 'kapalama'];
const config = {
  order: ids,
  enabled: ids,
  scope: 'all',
  startDate: '2026-11-01',
  endDate: '2026-11-30',
};
test('dragged location priority cannot place a later time first', () => {
  const slots = [
    { epoch: 200, locationId: 'ala-moana', service: 'Motor' },
    { epoch: 100, locationId: 'downtown', service: 'Motor' },
  ];
  assert.equal(sortAppointments(slots, ids)[0].locationId, 'downtown');
  assert.equal(slots[0].locationId, 'ala-moana', 'sort must not mutate original scan');
});
test('location order breaks exact time ties in either direction', () => {
  const slots = [
    { epoch: 100, locationId: 'ala-moana', service: 'Motor' },
    { epoch: 100, locationId: 'downtown', service: 'Motor' },
  ];
  assert.equal(sortAppointments(slots, ['downtown', 'ala-moana'])[0].locationId, 'downtown');
  assert.equal(sortAppointments(slots, ['ala-moana', 'downtown'])[0].locationId, 'ala-moana');
});
test('HST calendar day handles midnight across UTC dates', () => {
  assert.equal(hstDay(Date.parse('2026-10-20T09:59:59Z')), '2026-10-19');
  assert.equal(hstDay(Date.parse('2026-10-20T10:00:00Z')), '2026-10-20');
});
test('scan range is inclusive and ends at HST midnight boundary', () => {
  const range = scanRange('2026-10-19', '2026-11-17');
  assert.equal(range.start, '2026-10-19');
  assert.equal(range.end, '2026-11-17');
  assert.equal(range.cutoff, Date.parse('2026-11-18T09:59:59Z'));
});
test('settings reject missing/duplicate/unknown priorities and empty locations', () => {
  for (const order of [
    ['ala-moana', 'ala-moana', 'kapalama'],
    ['ala-moana'],
    ['ala-moana', 'downtown', 'bad'],
  ])
    assert.throws(() => validateSettings({ ...config, order }, ids));
  assert.throws(() => validateSettings({ ...config, enabled: [] }, ids));
  assert.throws(() => validateSettings({ ...config, enabled: ['bad'] }, ids));
  assert.throws(() => validateSettings({ ...config, scope: 'bad' }, ids));
  assert.throws(() => validateSettings({ ...config, endDate: '2026-10-01' }, ids));
});
test('validated settings are copied and include only intended fields', () => {
  const result = validateSettings(
    { ...config, extra: 'ignore', enabled: ['ala-moana', 'ala-moana'] },
    ids,
  );
  assert.deepEqual(result.enabled, ['ala-moana']);
  result.order.reverse();
  assert.equal(config.order[0], 'ala-moana');
  assert.equal(result.extra, undefined);
});

test('single-day range is inclusive and invalid dates are rejected', () => {
  assert.deepEqual(scanRange('2026-11-02', '2026-11-02'), {
    start: '2026-11-02',
    end: '2026-11-02',
    cutoff: Date.parse('2026-11-03T09:59:59Z'),
  });
  for (const pair of [
    ['2026-02-30', '2026-03-01'],
    ['2026-11-03', '2026-11-02'],
    ['', '2026-11-02'],
    ['2026-11-01', undefined],
  ])
    assert.throws(() => scanRange(...pair));
  assert.equal(scanRange('2028-02-29', '2028-02-29').end, '2028-02-29');
});
test('old look-ahead preferences migrate without changing location priorities', () => {
  const result = migrateSettings(
    { order: ['wahiawa', 'ala-moana'], enabled: ['wahiawa'], scope: 'motor', days: 30 },
    Date.parse('2026-10-20T01:00:00Z'),
  );
  assert.equal(result.startDate, '2026-10-19');
  assert.equal(result.endDate, '2026-11-17');
  assert.deepEqual(result.order, ['wahiawa', 'ala-moana']);
  assert.equal(migrateSettings(config), config);
});
