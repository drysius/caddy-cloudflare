// Structured logging: plain text or single-line JSON, chosen at startup.

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

let threshold = LEVELS.INFO;
let asJson = false;

export function setupLogging(level = "INFO", format = "text") {
  threshold = LEVELS[level] ?? LEVELS.INFO;
  asJson = format === "json";
}

function emit(levelName, msg, fields) {
  if (LEVELS[levelName] < threshold) return;
  const ts = new Date().toISOString();
  if (asJson) {
    process.stdout.write(JSON.stringify({ ts, level: levelName, msg, ...fields }) + "\n");
  } else {
    const extra = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
    process.stdout.write(`${ts} ${levelName.padEnd(7)} ${msg}${extra}\n`);
  }
}

export const log = {
  debug: (msg, fields) => emit("DEBUG", msg, fields),
  info: (msg, fields) => emit("INFO", msg, fields),
  warning: (msg, fields) => emit("WARNING", msg, fields),
  error: (msg, fields) => emit("ERROR", msg, fields),
};
