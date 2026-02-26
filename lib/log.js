const util = require('util');

const LEVELS = {
  INFO: 'INFO',
  CONFIG: 'CONFIG',
  WARN: 'WARN',
  ERROR: 'ERROR',
  INTERRUPT: 'INTERRUPT',
  DEBUG: 'DEBUG',
  TRACE: 'TRACE'
};

const LEVEL_ORDER = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  CONFIG: 30,
  WARN: 40,
  ERROR: 50,
  INTERRUPT: 60
};

const COLORS = {
  INFO: '\x1b[34m', // blue
  CONFIG: '\x1b[36m', // cyan
  WARN: '\x1b[33m', // yellow
  ERROR: '\x1b[31m', // red
  INTERRUPT: '\x1b[1;31m', // bold red
  DEBUG: '\x1b[90m', // bright black / gray
  TRACE: '\x1b[2;90m' // dim gray
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowTimestampLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function isErrLevel(level) {
  return level === LEVELS.WARN || level === LEVELS.ERROR || level === LEVELS.INTERRUPT;
}

function colourEnabled(stream) {
  if (!stream || !stream.isTTY) return false;
  if (process.env.NO_COLOR != null) return false;
  if (String(process.env.TERM || '') === 'dumb') return false;
  return true;
}

function normalizeLevel(level) {
  const s = String(level || '').trim().toUpperCase();
  return LEVELS[s] || LEVELS.INFO;
}

function minLevelFromEnv() {
  const s = String(process.env.LOG_LEVEL || '').trim();
  if (!s) return LEVELS.INFO;
  return normalizeLevel(s);
}

function shouldLog(level) {
  const lvl = normalizeLevel(level);
  const min = minLevelFromEnv();
  const a = LEVEL_ORDER[lvl] || LEVEL_ORDER.INFO;
  const b = LEVEL_ORDER[min] || LEVEL_ORDER.INFO;
  return a >= b;
}

function log(level, ...args) {
  const lvl = normalizeLevel(level);
  if (!shouldLog(lvl)) return;

  const stream = isErrLevel(lvl) ? process.stderr : process.stdout;
  const ts = nowTimestampLocal();
  const msg = util.format(...args);

  let tag = `[${lvl}]`;
  if (colourEnabled(stream)) {
    const c = COLORS[lvl] || COLORS.INFO;
    tag = `${c}${tag}\x1b[0m`;
  }

  stream.write(`${ts} ${tag} ${msg}\n`);
}

module.exports = {
  LEVELS,
  log,
  info: (...a) => log(LEVELS.INFO, ...a),
  config: (...a) => log(LEVELS.CONFIG, ...a),
  warn: (...a) => log(LEVELS.WARN, ...a),
  error: (...a) => log(LEVELS.ERROR, ...a),
  interrupt: (...a) => log(LEVELS.INTERRUPT, ...a),
  debug: (...a) => log(LEVELS.DEBUG, ...a),
  trace: (...a) => log(LEVELS.TRACE, ...a)
};
