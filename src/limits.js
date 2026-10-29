import { setTimeout as sleep } from 'node:timers/promises';

export function busy(message = 'Too many requests. Please try again shortly.') {
  return Object.assign(new Error(message), { status: 429, retryAfter: 60 });
}

// Fixed-size rate buckets; rejected requests cannot grow memory without bound.
export class RateLimits {
  constructor({ now = Date.now, maxKeys = 5000 } = {}) {
    Object.assign(this, { now, maxKeys });
    this.entries = new Map();
  }
  check(key, limit, window = 60000) {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) throw busy();
      entry = { count: 0, until: now + window };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) throw busy();
    entry.count++;
  }
}

export class WorkLimits {
  constructor(limits = { scan: 8, release: 20, booking: 4 }) {
    this.limits = limits;
    this.counts = new Map();
  }
  acquire(kind) {
    const count = this.counts.get(kind) || 0;
    if (count >= this.limits[kind]) throw busy(`All ${kind} slots are busy. Try again shortly.`);
    this.counts.set(kind, count + 1);
    let freed = false;
    return () => {
      if (!freed) this.counts.set(kind, this.counts.get(kind) - 1);
      freed = true;
    };
  }
}

// Cache the in-flight promise as well as its result. Failures may be retried.
export function cached(load, ttl = 60000, now = Date.now) {
  let pending,
    value,
    until = 0;
  return async () => {
    if (now() < until) return value;
    if (!pending) {
      pending = Promise.resolve()
        .then(load)
        .then((result) => {
          value = result;
          until = now() + ttl;
          return result;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}

// One queue for ALL upstream reads and booking submissions in this server.
export function limitedFetch({
  fetchImpl = fetch,
  concurrency = 4,
  spacing = 100,
  maxQueue = 64,
} = {}) {
  let active = 0,
    nextStart = 0;
  const queue = [];
  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      (async () => {
        job.options.signal?.throwIfAborted();
        const start = Math.max(Date.now(), nextStart);
        nextStart = start + spacing;
        await sleep(Math.max(0, start - Date.now()), undefined, { signal: job.options.signal });
        job.options.signal?.throwIfAborted();
        const response = await fetchImpl(job.url, { ...job.options, redirect: 'error' });
        // Include body transfer in the concurrency limit, and bound upstream payload size.
        const reader = response.body?.getReader();
        const chunks = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 2 * 1024 * 1024) throw Error('AlohaQ response exceeded the size limit.');
              chunks.push(Buffer.from(value));
            }
          } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
          }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          json: async () => JSON.parse(text),
        };
      })()
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  }
  return (url, options = {}) =>
    new Promise((resolve, reject) => {
      if (queue.length >= maxQueue)
        return reject(busy('Upstream request queue is full. Try again later.'));
      queue.push({ url, options, resolve, reject });
      drain();
    });
}
