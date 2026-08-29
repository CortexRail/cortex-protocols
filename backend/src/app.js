const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const assetsRouter = require("./routes/assets");
const agentsRouter = require("./routes/agents");
const streamsRouter = require("./routes/streams");
const licensesRouter = require("./routes/licenses");
const analyticsRouter = require("./routes/analytics");
const stellarRouter = require("./routes/stellar");
const internalRouter = require("./routes/internal");
const healthRouter = require("./routes/health");
const adminRouter = require("./routes/admin");
const complianceRouter = require("./routes/compliance");
const protocolRouter = require("./routes/protocol");
const escrowRouter = require("./routes/escrow");
const disputesRouter = require("./routes/disputes");
const pricingRouter = require("./routes/pricing");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const app = express();

// ── Security & logging ────────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (process.env.CORS_ORIGINS || "http://localhost:3000")
      .split(",")
      .map((o) => o.trim()),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const appLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.APP_RATE_LIMIT_MAX ?? (process.env.NODE_ENV === "test" ? 200 : 3000)),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(appLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ version: '0.1.0',
    status: "ok",
    service: "cortex-protocol-backend",
    timestamp: new Date().toISOString(),
    network: process.env.STELLAR_NETWORK || "testnet",
  });
});
app.use("/health", healthRouter);

// ── Swagger Docs ──────────────────────────────────────────────────────────────
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Cortex Protocol API",
      version: "0.1.0",
      description: "Intelligence Rail backend API",
    },
  },
  apis: ["./src/routes/*.js"],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const approvalRoutes = require("./routes/approvalRoutes");

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/v1/assets", assetsRouter);
app.use("/api/v1/agents", agentsRouter);
app.use("/api/v1/streams", streamsRouter);
app.use("/api/v1/licenses", licensesRouter);
app.use("/api/v1/analytics", analyticsRouter);
app.use("/api/v1/stellar", stellarRouter);
app.use("/api/v1/internal", internalRouter);
app.use("/api/v1/internal/pricing", pricingRouter);
app.use("/api/v1/pricing", pricingRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/admin", complianceRouter);
app.use("/api/v1/protocol", protocolRouter);
app.use("/api/v1/escrow", escrowRouter);
app.use("/api/v1/disputes", disputesRouter);
app.use("/api/v1", approvalRoutes);

// ── Error handling ────────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
