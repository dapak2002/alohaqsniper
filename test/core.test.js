import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distance,
  origin,
  rankedLocations,
  slotEpoch,
  compareSlots,
  validateDetails,
} from '../src/core.js';
test('distance ranking uses chosen origin', () => {
  assert.equal(rankedLocations('all', origin('ala-moana'))[0].id, 'ala-moana');
  assert.equal(rankedLocations('all', origin('kapolei'))[0].id, 'kapolei');
  assert.equal(distance(origin('ala-moana'), origin('ala-moana')), 0);
  assert.ok(Math.abs(distance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 69.09) < 0.1);
});
test('reject malformed coordinates and unknown locations', () => {
  for (const x of ['abc', '91,0', ',0', '0,181', '1,2,3']) assert.throws(() => origin(x));
  assert.throws(() => rankedLocations('nope', origin('ala-moana')));
});
test('HST parsing handles noon and midnight independently of host timezone', () => {
  assert.equal(slotEpoch('November 2, 2026', '12:00 AM HST'), Date.parse('2026-11-02T10:00:00Z'));
  assert.equal(slotEpoch('November 2, 2026', '12:00 PM HST'), Date.parse('2026-11-02T22:00:00Z'));
  assert.throws(() => slotEpoch('bad', '10:30 AM'));
});
test('appointment time always wins over distance, including legacy distance mode', () => {
  const near = { miles: 1, epoch: 20 },
    far = { miles: 5, epoch: 10 };
  assert.equal([near, far].sort(compareSlots('earliest'))[0], far);
  assert.equal([far, near].sort(compareSlots('distance'))[0], far);
  assert.ok(compareSlots('earliest')({ miles: 1, epoch: 10 }, { miles: 2, epoch: 10 }) < 0);
});
test('details accept formatted US phones and reject incomplete input', () => {
  assert.deepEqual(
    validateDetails({ firstName: ' Test ', lastName: ' User ', phone: '+1 (808) 555-0100' }),
    { firstName: 'Test', lastName: 'User', phone: '8085550100' },
  );
  assert.throws(() => validateDetails({ firstName: 'Test', lastName: 'User', phone: '123' }));
  assert.throws(() => validateDetails({ firstName: '', lastName: 'User', phone: '8085550100' }));
});
