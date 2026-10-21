import test from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../src/sessions.js';

test('browser sessions isolate state and use secure private cookies', () => {
  const sessions = new Sessions(() => ({ settings: {}, busy: () => false }));
  const a = sessions.get('', true),
    b = sessions.get('', true);
  a.value.settings.name = 'first';
  assert.equal(b.value.settings.name, undefined);
  assert.equal(sessions.get(a.cookie).value, a.value);
  assert.match(a.cookie, /HttpOnly; SameSite=Strict; Secure$/);
  assert.notEqual(sessions.get('alohaq_session=forged').value, a.value);
});
test('idle sessions expire, active jobs remain and capacity is bounded', () => {
  let now = 0;
  const sessions = new Sessions(
    () => ({
      active: false,
      busy() {
        return this.active;
      },
    }),
    { ttl: 100, limit: 2, now: () => now },
  );
  const a = sessions.get(''),
    b = sessions.get('');
  a.value.active = true;
  assert.throws(() => sessions.get(''), /busy/);
  now = 101;
  assert.equal(sessions.get(a.cookie).value, a.value);
  assert.notEqual(sessions.get(b.cookie).value, b.value);
  assert.equal(sessions.entries.size, 2);
});
