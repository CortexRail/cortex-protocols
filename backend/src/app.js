const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const assetsRouter = require("./routes/assets");
const agentsRouter = require("./routes/agents");
const streamsRouter = require("./routes/streams");
const stellarRouter = require("./routes/stellar");
const internalRouter = require("./routes/internal");
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
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

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

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/v1/assets", assetsRouter);
app.use("/api/v1/agents", agentsRouter);
app.use("/api/v1/streams", streamsRouter);
app.use("/api/v1/stellar", stellarRouter);
app.use("/api/v1/internal", internalRouter);

// ── Error handling ────────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
