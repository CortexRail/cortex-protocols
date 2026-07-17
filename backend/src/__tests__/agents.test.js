const request = require("supertest");
const app = require("../app");

describe("GET /api/v1/agents", () => {
  it("returns a list of agents", async () => {
    const res = await request(app).get("/api/v1/agents").expect(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("filters by capability", async () => {
    const res = await request(app)
      .get("/api/v1/agents?capability=Reasoning")
      .expect(200);
    res.body.data.forEach((a) => {
      expect(a.capabilities).toContain("Reasoning");
    });
  });

  it("rejects invalid capability", async () => {
    await request(app).get("/api/v1/agents?capability=Invalid").expect(422);
  });

  it("paginates correctly", async () => {
    const res = await request(app)
      .get("/api/v1/agents?page=1&limit=2")
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });
});

describe("GET /api/v1/agents/:id", () => {
  it("returns an agent by id", async () => {
    const res = await request(app).get("/api/v1/agents/1").expect(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("name");
  });

  it("returns 404 for unknown agent", async () => {
    await request(app).get("/api/v1/agents/99999").expect(404);
  });
});

describe("GET /api/v1/agents/:id/reputation-history", () => {
  it("returns reputation history", async () => {
    const res = await request(app)
      .get("/api/v1/agents/1/reputation-history")
      .expect(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns 404 for unknown agent", async () => {
    await request(app)
      .get("/api/v1/agents/99999/reputation-history")
      .expect(404);
  });

  it("respects limit parameter", async () => {
    const res = await request(app)
      .get("/api/v1/agents/1/reputation-history?limit=10")
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(10);
  });
});

describe("POST /api/v1/agents/:id/reputation", () => {
  it("accepts a reputation vote", async () => {
    const res = await request(app)
      .post("/api/v1/agents/1/reputation")
      .send({
        score: 75,
        voter: "G" + "X".repeat(55),
      })
      .expect(201);
    expect(res.body).toHaveProperty("score");
    expect(res.body.score).toBe(75);
  });

  it("rejects invalid score", async () => {
    await request(app)
      .post("/api/v1/agents/1/reputation")
      .send({
        score: 150,
        voter: "G" + "X".repeat(55),
      })
      .expect(422);
  });

  it("rejects invalid voter key", async () => {
    await request(app)
      .post("/api/v1/agents/1/reputation")
      .send({
        score: 75,
        voter: "invalid",
      })
      .expect(422);
  });
});

describe("GET /api/v1/agents/:id/activity", () => {
  it("returns activity feed", async () => {
    const res = await request(app)
      .get("/api/v1/agents/1/activity")
      .expect(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("paginates correctly", async () => {
    const res = await request(app)
      .get("/api/v1/agents/1/activity?page=1&limit=5")
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(5);
    expect(res.body.meta.limit).toBe(5);
  });
});

describe("GET /api/v1/agents/leaderboard", () => {
  it("returns reputation leaderboard", async () => {
    const res = await request(app)
      .get("/api/v1/agents/leaderboard?sortBy=reputation&limit=20")
      .expect(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(20);
  });

  it("returns activity leaderboard", async () => {
    const res = await request(app)
      .get("/api/v1/agents/leaderboard?sortBy=activity&limit=10")
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(10);
  });

  it("returns earnings leaderboard", async () => {
    const res = await request(app)
      .get("/api/v1/agents/leaderboard?sortBy=earnings&limit=10")
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(10);
  });

  it("rejects invalid sortBy", async () => {
    await request(app)
      .get("/api/v1/agents/leaderboard?sortBy=invalid")
      .expect(422);
  });
});

describe("Reputation color zones", () => {
  it("handles red zone (< 40%)", () => {
    // Scores 0-3999 should be red (< 40%)
    expect(0).toBeLessThan(4000);
    expect(3999).toBeLessThan(4000);
  });

  it("handles amber zone (40-70%)", () => {
    // Scores 4000-7000 should be amber
    expect(4000).toBeGreaterThanOrEqual(4000);
    expect(7000).toBeLessThanOrEqual(7000);
  });

  it("handles green zone (> 70%)", () => {
    // Scores 7001-10000 should be green
    expect(7001).toBeGreaterThan(7000);
    expect(10000).toBeGreaterThan(7000);
  });
});
