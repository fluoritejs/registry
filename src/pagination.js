const MAX_OFFSET = 100000;
const INT4_MAX = 2147483647;

export function parseCursor(query) {
  if (!query || !query.cursor) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(String(query.cursor), "base64").toString(),
    );
    if (Number.isInteger(decoded.offset) && decoded.offset >= 0) {
      return Math.min(decoded.offset, MAX_OFFSET);
    }
  } catch {
    /* invalid cursor, use 0 */
  }
  return 0;
}

export function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}

export function parseKeysetCursor(query) {
  if (!query || !query.cursor) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(String(query.cursor), "base64").toString(),
    );
    if (Number.isInteger(decoded.sortKey) && decoded.sortKey >= 0) {
      // sortKey 0 is a valid terminal position, not "no cursor"; callers
      // treat the returned null as never-a-cursor, so 0 must survive parsing.
      return Math.min(decoded.sortKey, INT4_MAX);
    }
  } catch {
    /* invalid cursor, use the start of the collection */
  }
  return null;
}

export function encodeKeysetCursor(sortKey) {
  return Buffer.from(JSON.stringify({ sortKey })).toString("base64");
}

export function parseLimit(query, defaultPageSize, maxPageSize) {
  if (!query || query.limit === undefined) return defaultPageSize;
  const parsed = Number.parseInt(String(query.limit), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultPageSize;
  return Math.min(parsed, maxPageSize);
}
