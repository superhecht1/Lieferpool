/**
 * Strukturiertes Logging für FrischKette
 * Ersetzt console.log mit Winston-ähnlichem Format
 */
const levels = { error:0, warn:1, info:2, http:3, debug:4 };
const isDev  = process.env.NODE_ENV !== 'production';
const minLevel = isDev ? 'debug' : 'info';

function timestamp() {
  return new Date().toISOString();
}

function format(level, message, meta = {}) {
  const entry = {
    ts:    timestamp(),
    level,
    msg:   message,
    ...meta,
  };

  if (isDev) {
    const colors = { error:'\x1b[31m', warn:'\x1b[33m', info:'\x1b[36m', http:'\x1b[35m', debug:'\x1b[37m' };
    const reset  = '\x1b[0m';
    const c      = colors[level] || '';
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${c}[${level.toUpperCase()}]${reset} ${timestamp()} ${message}${metaStr}`;
  }

  return JSON.stringify(entry);
}

function log(level, message, meta) {
  if (levels[level] > levels[minLevel]) return;
  const out = format(level, message, meta);
  if (level === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

const logger = {
  error: (msg, meta) => log('error', msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  http:  (msg, meta) => log('http',  msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),

  // HTTP Request Logger Middleware
  middleware() {
    return (req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        const level = res.statusCode >= 500 ? 'error'
                    : res.statusCode >= 400 ? 'warn' : 'http';
        log(level, `${req.method} ${req.path}`, {
          status: res.statusCode,
          ms,
          ip:  req.ip,
          ua:  req.headers['user-agent']?.slice(0,60),
        });
      });
      next();
    };
  },
};

module.exports = logger;
