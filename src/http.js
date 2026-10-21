export const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
export async function readBody(req) {
  let data = '';
  for await (const part of req) {
    data += part;
    if (data.length > 16384) throw new Error('Request too large.');
  }
  return JSON.parse(data || '{}');
}
