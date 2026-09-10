import pc from "picocolors";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = "info";

export function setLevel(level) {
  currentLevel = level;
}

function shouldLog(level) {
  return (LEVELS[level] ?? 2) <= (LEVELS[currentLevel] ?? 2);
}

function formatTime() {
  return new Date().toISOString();
}

export const log = {
  error(msg, ...args) {
    if (shouldLog("error"))
      console.error(`${formatTime()} ${pc.red("ERROR")} ${msg}`, ...args);
  },
  warn(msg, ...args) {
    if (shouldLog("warn"))
      console.error(`${formatTime()} ${pc.yellow("WARN")} ${msg}`, ...args);
  },
  info(msg, ...args) {
    if (shouldLog("info"))
      console.log(`${formatTime()} ${pc.cyan("INFO")} ${msg}`, ...args);
  },
  debug(msg, ...args) {
    if (shouldLog("debug"))
      console.log(`${formatTime()} ${pc.gray("DEBUG")} ${msg}`, ...args);
  },
};
