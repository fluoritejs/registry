export function isSafeSegment(value) {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    !/[/\\]/.test(value)
  );
}
