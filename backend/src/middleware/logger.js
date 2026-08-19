const { v4: uuidv4 } = require('uuid');
const { logger, asyncLocalStorage } = require('../utils/logger');

const requestLogger = (req, res, next) => {
  // Check for correlationId in headers (case-insensitive in express req.headers)
  const correlationId = req.headers['correlationid'] || req.headers['x-correlation-id'] || null;
  const requestId = uuidv4();
  
  const store = { requestId };
  if (correlationId) {
    store.correlationId = correlationId;
  }
  
  asyncLocalStorage.run(store, () => {
    const start = Date.now();
    
    // Also attach to req in case other middleware needs it
    req.requestId = requestId;
    if (correlationId) req.correlationId = correlationId;
    
    res.setHeader('X-Request-Id', requestId);
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      // Do not log health checks to avoid noise
      if (req.originalUrl !== '/health') {
        logger.info('Request completed', {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          duration,
        });
      }
    });
    
    next();
  });
};

module.exports = { requestLogger };
