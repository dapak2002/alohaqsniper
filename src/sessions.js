import { randomBytes } from 'node:crypto';

const COOKIE_NAME = 'alohaq_session';
const COOKIE_PREFIX = `${COOKIE_NAME}=`;

export class Sessions {
  constructor(create, { ttl = 24 * 60 * 60 * 1000, limit = 500, now = Date.now } = {}) {
    this.create = create;
    this.ttl = ttl;
    this.limit = limit;
    this.now = now;
    this.entries = new Map();
  }
  get(cookie, secure = false) {
    const now = this.now();
    for (const [id, s] of this.entries) {
      if (now - s.seen > this.ttl && !s.value.busy()) this.entries.delete(id);
    }
    const id = String(cookie || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(COOKIE_PREFIX))
      ?.slice(COOKIE_PREFIX.length);
    let entry = this.entries.get(id);
    if (entry) {
      entry.seen = now;
      return { value: entry.value };
    }
    if (this.entries.size >= this.limit) throw Error('The server is busy. Please try again later.');
    const key = randomBytes(32).toString('hex');
    entry = { seen: now, value: this.create() };
    this.entries.set(key, entry);
    return {
      value: entry.value,
      cookie: `${COOKIE_PREFIX}${key}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
    };
  }
}
