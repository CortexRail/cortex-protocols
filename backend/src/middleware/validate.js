const { validationResult } = require("express-validator");

/**
 * Express middleware that runs after express-validator rules.
 * Returns 422 if any validation errors exist.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: "Validation Error",
      details: errors.array(),
    });
  }
  next();
}

module.exports = validate;
