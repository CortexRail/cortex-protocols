/**
 * Wrap an async route handler so rejections reach the global error handler
 * instead of crashing the process (Express 4 doesn't catch them natively).
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
