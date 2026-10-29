import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function passwordAccess(password) {
  if (!password) return () => true;
  if (password.length < 16) throw Error('APP_PASSWORD must contain at least 16 characters.');
  const digest = (value) => createHash('sha256').update(value).digest();
  const expected = digest(password);
  return (authorization) => {
    if (!authorization?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0 && timingSafeEqual(expected, digest(decoded.slice(separator + 1)));
  };
}

// Forwarded headers are ignored unless the operator explicitly configures trusted hops.
export function clientAddress(req, trustedHops = 0) {
  if (!trustedHops) return req.socket.remoteAddress || 'unknown';
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim());
  const candidate = forwarded[forwarded.length - trustedHops];
  return isIP(candidate || '') ? candidate : req.socket.remoteAddress || 'unknown';
}
