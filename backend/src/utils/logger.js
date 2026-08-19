const { createLogger, format, transports } = require('winston');
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

const contextFormat = format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store) {
    if (store.requestId) info.requestId = store.requestId;
    if (store.correlationId) info.correlationId = store.correlationId;
  }
  return info;
});

const redactFormat = format((info) => {
  const sensitiveKeys = ['token', 'secret', 'password', 'authorization'];
  
  const redact = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (sensitiveKeys.some(k => key.toLowerCase().includes(k))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        redact(obj[key]);
      }
    }
    return obj;
  };
  
  // Redact properties directly on info (if they are top-level metadata fields)
  // Need to clone to avoid mutating the original object deeply, 
  // but winston format creates a shallow clone by default.
  // We'll just loop over keys and redact.
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message' || key === 'timestamp' || key === 'requestId' || key === 'correlationId') continue;
    if (sensitiveKeys.some(k => key.toLowerCase().includes(k))) {
      info[key] = '[REDACTED]';
    } else if (typeof info[key] === 'object') {
      // clone before redacting to avoid mutating original objects passed to logger
      info[key] = redact(JSON.parse(JSON.stringify(info[key])));
    }
  }

  return info;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    contextFormat(),
    redactFormat(),
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console()
  ]
});

module.exports = { logger, asyncLocalStorage };
