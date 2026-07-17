const request = require("supertest");
const app = require("../app");
const { seed } = require("../db/seed");
const { truncateAll, closePool, OWNER_B } = require("./helpers/testDb");

beforeAll(async () => {
  await truncateAll();
  await seed();
});

afterAll(async () => {
  await closePool();
});

describe("GET /api/v1/agents", () => {
  it("returns a list of agents", async () => {
    const res = await request(app).get("/api/v1/agents").expect(200);
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("filters by capability", async () => {
    const res = await request(app)
      .get("/api/v1/agents?capability=Reasoning")
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach((a) => {
      expect(a.capabilities).toContain("Reasoning");
    });
  });

  it("filters by minReputation", async () => {
    const res = await request(app)
      .get("/api/v1/agents?minReputation=9000")
      .expect(200);
    res.body.data.forEach((a) => {
      expect(a.reputation).toBeGreaterThanOrEqual(9000);
    });
  });

  it("rejects invalid capability", async () => {
    await request(app).get("/api/v1/agents?capability=FlyLikeBird").expect(422);
  });
});

describe("GET /api/v1/agents/:id", () => {
  it("returns an agent by id", async () => {
    const res = await request(app).get("/api/v1/agents/1").expect(200);
    expect(res.body.id).toBe(1);
  });

  it("returns 404 for unknown agent", async () => {
    await request(app).get("/api/v1/agents/99999").expect(404);
  });
});

describe("POST /api/v1/agents", () => {
  it("registers an agent and persists it", async () => {
    const payload = {
      id: 800,
      owner: OWNER_B,
      name: "Persisted Agent",
      description: "Registered through the API and stored in Postgres.",
      capabilities: ["WebResearch", "Reasoning"],
    };

    await request(app).post("/api/v1/agents").send(payload).expect(201);

    const fetched = await request(app).get("/api/v1/agents/800").expect(200);
    expect(fetched.body.name).toBe("Persisted Agent");
    expect(fetched.body.capabilities).toEqual(["WebResearch", "Reasoning"]);
  });

  it("rejects unknown capabilities", async () => {
    await request(app)
      .post("/api/v1/agents")
      .send({
        id: 801,
        owner: OWNER_B,
        name: "Bad Agent",
        description: "Has made-up capabilities.",
        capabilities: ["TimeTravel"],
      })
      .expect(422);
  });
});

describe("GET /health", () => {
  it("responds ok", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
  });
});
