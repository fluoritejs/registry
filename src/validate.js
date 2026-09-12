const MAX_SEGMENT_LENGTH = 255;

export function isSafeSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SEGMENT_LENGTH &&
    !value.includes("\u0000") &&
    value !== "." &&
    value !== ".." &&
    !/[/\\]/.test(value)
  );
}
