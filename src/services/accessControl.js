export function extractBearerToken(headers = {}) {
  return String(headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
}
