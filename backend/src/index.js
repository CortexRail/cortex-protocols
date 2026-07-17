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
    console.log(
      `[cortex-protocol] migrations: ${applied.length} applied, ${skipped} up to date`
    );
  }

  const db = await healthCheck();
  if (!db.healthy) {
    throw new Error(`database unreachable: ${db.error}`);
  }
  console.log(`[cortex-protocol] database healthy (${db.latencyMs}ms)`);

  const server = app.listen(PORT, () => {
    console.log(
      `[cortex-protocol] backend running on port ${PORT} (${process.env.NODE_ENV || "development"})`
    );
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Stop accepting connections, let in-flight requests finish, then drain
  // the pg pool so no query is killed mid-transaction.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cortex-protocol] ${signal} received — shutting down`);

    server.close(async () => {
      try {
        await closePool();
        console.log("[cortex-protocol] database pool closed, bye");
        process.exit(0);
      } catch (err) {
        console.error("[cortex-protocol] error during shutdown:", err.message);
        process.exit(1);
      }
    });

    // Hard-stop if connections refuse to drain.
    setTimeout(() => {
      console.error("[cortex-protocol] forced shutdown after 10s");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("[cortex-protocol] failed to start:", err.message);
  process.exit(1);
});
