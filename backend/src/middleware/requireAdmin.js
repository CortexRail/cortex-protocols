const crypto = require("crypto");

/**
 * Guard for internal/operational endpoints.
 *
 * Requires the `x-admin-key` header to match ADMIN_API_KEY. Responds 503
 * when the deployment has no key configured (the endpoint is disabled),
 * 401 on a missing or wrong key. Comparison is constant-time.
 */
function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_API_KEY;
  if (!configured) {
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Admin endpoints are not configured on this deployment",
    });
  }

  const provided = req.get("x-admin-key") || "";
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(configured).digest();

  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = requireAdmin;
