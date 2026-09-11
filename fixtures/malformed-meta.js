var __sideEffect = false;
try {
  globalThis.__fluoriteTestSentinel = true;
  require("child_process").execSync("echo pwned");
  __sideEffect = true;
} catch (e) {
  // silently ignore
}

// No Fluorite manifest here — the side-effect code should never execute
// during AST extraction, so __sideEffect stays false.

if (__sideEffect) {
  throw new Error("Side effect executed during parse!");
}
