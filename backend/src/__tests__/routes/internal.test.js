const request = require("supertest");
const app = require("../../app");
const { closePool } = require("../helpers/testDb");

const ADMIN_KEY = "test-admin-key";

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterAll(async () => {
  delete process.env.ADMIN_API_KEY;
  await closePool();
});

describe("GET /api/v1/internal/db-stats", () => {
  it("rejects requests without the admin key", async () => {
    await request(app).get("/api/v1/internal/db-stats").expect(401);
  });

  it("rejects requests with a wrong admin key", async () => {
    await request(app)
      .get("/api/v1/internal/db-stats")
      .set("x-admin-key", "nope")
      .expect(401);
  });

  it("returns pool metrics and database health for admins", async () => {
    const res = await request(app)
      .get("/api/v1/internal/db-stats")
      .set("x-admin-key", ADMIN_KEY)
      .expect(200);

    expect(res.body.pool).toEqual(
      expect.objectContaining({
        max: expect.any(Number),
        total: expect.any(Number),
        idle: expect.any(Number),
        waiting: expect.any(Number),
      })
    );
    expect(res.body.pool.max).toBe(20);
    expect(res.body.database.healthy).toBe(true);
    expect(typeof res.body.database.latencyMs).toBe("number");
    expect(res.body.timestamp).toBeDefined();
  });

  it("returns 503 when no admin key is configured at all", async () => {
    delete process.env.ADMIN_API_KEY;
    try {
      await request(app)
        .get("/api/v1/internal/db-stats")
        .set("x-admin-key", ADMIN_KEY)
        .expect(503);
    } finally {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
    }
  });
});

describe("GET /api/v1/internal/pipeline-metrics and /dead-letters", () => {
  it("returns pipeline metrics for admins", async () => {
    const res = await request(app)
      .get("/api/v1/internal/pipeline-metrics")
      .set("x-admin-key", ADMIN_KEY)
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        events_per_minute: expect.any(Number),
        processing_latency_p99: expect.any(Number),
        queue_depth: expect.any(Number),
        dead_letter_count: expect.any(Number),
        last_processed_ledger: expect.any(Number),
      })
    );
  });

  it("returns dead-letter queue status for admins", async () => {
    const res = await request(app)
      .get("/api/v1/internal/dead-letters")
      .set("x-admin-key", ADMIN_KEY)
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        deadLetters: expect.any(Array),
        status: expect.objectContaining({ circuitOpen: expect.any(Boolean) }),
      })
    );
  });
});
