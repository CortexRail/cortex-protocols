/**
 * 404 handler — catches routes that don't match any registered handler.
 */
function notFoundHandler(req, res, _next) {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} does not exist`,
  });
}

/**
 * Global error handler.
 */
function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  if (process.env.NODE_ENV !== "production") {
    console.error(err);
  }

  res.status(status).json({
    error: status >= 500 ? "Internal Server Error" : message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
}

module.exports = { notFoundHandler, errorHandler };
