export const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
export async function readBody(req) {
  let data = '';
  let bytes = 0;
  for await (const part of req) {
    bytes += Buffer.byteLength(part);
    if (bytes > 16384) throw Object.assign(new Error('Request too large.'), { status: 413 });
    data += part;
  }
  const value = JSON.parse(data || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('Expected a JSON object.');
  return value;
}
