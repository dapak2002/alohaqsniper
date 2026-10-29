import { busy } from './limits.js';
import { randomBytes } from 'node:crypto';

const COOKIE_NAME = 'alohaq_session';
const COOKIE_PREFIX = `${COOKIE_NAME}=`;

export class Sessions {
  constructor(
    create,
    { ttl = 24 * 60 * 60 * 1000, limit = 500, maxAge = 26 * 60 * 60 * 1000, now = Date.now } = {},
  ) {
    this.create = create;
    this.ttl = ttl;
    this.maxAge = maxAge;
    this.limit = limit;
    this.now = now;
    this.entries = new Map();
  }
  cleanup() {
    const now = this.now();
    for (const [id, s] of this.entries) {
      s.value.cleanup?.();
      if ((now - s.seen > this.ttl || now - s.created > this.maxAge) && !s.value.busy()) {
        s.value.dispose?.();
        this.entries.delete(id);
      }
    }
  }
  get(cookie, secure = false, { create = true, beforeCreate = () => {} } = {}) {
    const now = this.now();
    this.cleanup();
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
    if (!create)
      throw Object.assign(
        new Error(
          'Your session expired or the server restarted. Reload the page. Check AlohaQ before retrying any unconfirmed booking.',
        ),
        { status: 401 },
      );
    beforeCreate();
    if (this.entries.size >= this.limit) throw busy('The server is busy. Please try again later.');
    const key = randomBytes(32).toString('hex');
    entry = { seen: now, created: now, value: this.create() };
    this.entries.set(key, entry);
    return {
      value: entry.value,
      cookie: `${COOKIE_PREFIX}${key}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
    };
  }
}
