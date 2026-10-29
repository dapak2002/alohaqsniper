import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimits, WorkLimits, cached, limitedFetch } from '../src/limits.js';
import { passwordAccess, clientAddress } from '../src/access.js';

test('rate limits expire and bound new keys', () => {
  let now = 0;
  const rate = new RateLimits({ now: () => now, maxKeys: 1 });
  rate.check('a', 1, 10);
  assert.throws(() => rate.check('a', 1, 10), { status: 429 });
  assert.throws(() => rate.check('b', 1, 10), { status: 429 });
  now = 10;
  rate.check('b', 1, 10);
});
test('job capacity is reusable and release is idempotent', () => {
  const work = new WorkLimits({ scan: 1 });
  const done = work.acquire('scan');
  assert.throws(() => work.acquire('scan'), { status: 429 });
  done();
  done();
  work.acquire('scan')();
  assert.equal(work.counts.get('scan'), 0);
});
test('catalog combines concurrent requests, expires, and recovers from failure', async () => {
  let calls = 0,
    now = 0,
    fail = true;
  const load = cached(
    async () => {
      calls++;
      if (fail) throw Error('offline');
      return calls;
    },
    10,
    () => now,
  );
  await assert.rejects(Promise.all([load(), load()]), /offline/);
  assert.equal(calls, 1);
  fail = false;
  assert.deepEqual(await Promise.all([load(), load()]), [2, 2]);
  assert.equal(await load(), 2);
  now = 10;
  assert.equal(await load(), 3);
});
test('upstream queue bounds concurrency and rejects overflow without submitting', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const upstream = limitedFetch({
    concurrency: 1,
    maxQueue: 1,
    spacing: 0,
    fetchImpl: async () => {
      calls++;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return new Response('{}');
    },
  });
  const a = upstream('https://example.test'),
    b = upstream('https://example.test');
  await assert.rejects(upstream('https://example.test'), { status: 429 });
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});
test('aborted upstream jobs never submit; oversized responses fail', async () => {
  let calls = 0;
  const upstream = limitedFetch({
    spacing: 0,
    fetchImpl: async () => {
      calls++;
      return new Response('a'.repeat(2 * 1024 * 1024 + 1));
    },
  });
  await assert.rejects(upstream('https://example.test', { signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
  await assert.rejects(upstream('https://example.test'), /size limit/);
});
test('password gate and proxy trust require explicit configuration', () => {
  const check = passwordAccess('a-long-test-password');
  assert.equal(check(), false);
  assert.equal(check('Basic ' + Buffer.from('user:wrong').toString('base64')), false);
  assert.equal(check('Basic ' + Buffer.from('user:a-long-test-password').toString('base64')), true);
  assert.throws(() => passwordAccess('short'));
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.2' },
  };
  assert.equal(clientAddress(req), '127.0.0.1');
  assert.equal(clientAddress(req, 1), '192.0.2.2');
});
