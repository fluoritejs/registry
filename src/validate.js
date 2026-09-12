const MAX_SEGMENT_LENGTH = 255;

export function isSafeSegment(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SEGMENT_LENGTH ||
    value === "." ||
    value === ".." ||
    /[/\\]/.test(value)
  ) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
