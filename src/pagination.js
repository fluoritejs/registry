export function parseCursor(query) {
  if (!query || !query.cursor) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(String(query.cursor), "base64").toString(),
    );
    if (Number.isInteger(decoded.offset) && decoded.offset >= 0) {
      return decoded.offset;
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
    if (Number.isFinite(decoded.sortKey)) {
      return decoded.sortKey;
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
