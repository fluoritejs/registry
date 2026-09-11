export function isSafeSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    value !== "." &&
    value !== ".." &&
    !/[/\\]/.test(value)
  );
}
