require("dotenv").config();

const app = require("./app");
const { migrate } = require("./db/migrate");
const { closePool, healthCheck } = require("./db/connection");

const PORT = process.env.PORT || 4000;

async function start() {
  // Apply pending migrations on boot unless explicitly disabled
  // (e.g. when a deploy pipeline runs `npm run migrate` separately).
  if (process.env.RUN_MIGRATIONS_ON_BOOT !== "false") {
    const { applied, skipped } = await migrate();
    logger.info(
      `[cortex-protocol] migrations: ${applied.length} applied, ${skipped} up to date`
    );
  }

  const db = await healthCheck();
  if (!db.healthy) {
    throw new Error(`database unreachable: ${db.error}`);
  }
  logger.info(`[cortex-protocol] database healthy (${db.latencyMs}ms)`);

  const server = app.listen(PORT, () => {
    logger.info(
      `[cortex-protocol] backend running on port ${PORT} (${process.env.NODE_ENV || "development"})`
    );
  });

  const { startPipeline, stopPipeline } = require("./pipeline/EventPipeline");
  await startPipeline({ intervalMs: 5_000 });

  // Start periodic Merkle anchoring of the audit log.
  const { MerkleAnchor } = require("./audit/MerkleAnchor");
const { logger } = require("./utils/logger");
  MerkleAnchor.getInstance().start();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Stop accepting connections, let in-flight requests finish, then drain
  // the pg pool so no query is killed mid-transaction.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[cortex-protocol] ${signal} received — shutting down`);

    server.close(async () => {
      try {
        await stopPipeline();
        MerkleAnchor.getInstance().stop();
        await closePool();
        logger.info("[cortex-protocol] database pool closed, bye");
        process.exit(0);
      } catch (err) {
        logger.error("[cortex-protocol] error during shutdown:", err.message);
        process.exit(1);
      }
    });

    // Hard-stop if connections refuse to drain.
    setTimeout(() => {
      logger.error("[cortex-protocol] forced shutdown after 10s");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error("[cortex-protocol] failed to start:", err.message);
  process.exit(1);
});
