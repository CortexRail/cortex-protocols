const request = require("supertest");
const app = require("../app");
const {
  truncateAll,
  closePool,
  buildStream,
  OWNER_A,
  OWNER_B,
} = require("./helpers/testDb");

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

async function createStreamViaApi(overrides = {}) {
  const stream = buildStream(overrides);
  // route validation only accepts the on-chain fields
  const payload = {
    id: stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    deposit: stream.deposit,
    ratePerSecond: stream.ratePerSecond,
    startTime: stream.startTime,
    endTime: stream.endTime,
  };
  const res = await request(app).post("/api/v1/streams").send(payload);
  return { payload, res };
}

describe("POST /api/v1/streams", () => {
  it("indexes a stream with Active status and zero withdrawn", async () => {
    const { res } = await createStreamViaApi();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("Active");
    expect(res.body.withdrawn).toBe(0);
  });

  it("rejects invalid payloads", async () => {
    await request(app)
      .post("/api/v1/streams")
      .send({ id: 1, sender: "short" })
      .expect(422);
  });
});

describe("GET /api/v1/streams", () => {
  it("filters by sender and recipient", async () => {
    await createStreamViaApi({ sender: OWNER_A, recipient: OWNER_B });
    await createStreamViaApi({ sender: OWNER_B, recipient: OWNER_A });

    const bySender = await request(app)
      .get(`/api/v1/streams?sender=${OWNER_A}`)
      .expect(200);
    expect(bySender.body.data).toHaveLength(1);
    expect(bySender.body.data[0].sender).toBe(OWNER_A);

    const byRecipient = await request(app)
      .get(`/api/v1/streams?recipient=${OWNER_A}`)
      .expect(200);
    expect(byRecipient.body.data).toHaveLength(1);
    expect(byRecipient.body.data[0].recipient).toBe(OWNER_A);
  });

  it("filters by status", async () => {
    await createStreamViaApi();
    const res = await request(app)
      .get("/api/v1/streams?status=Cancelled")
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe("GET /api/v1/streams/:id", () => {
  it("returns a stream by id", async () => {
    const { payload } = await createStreamViaApi();
    const res = await request(app)
      .get(`/api/v1/streams/${payload.id}`)
      .expect(200);
    expect(res.body.id).toBe(payload.id);
  });

  it("returns 404 for unknown stream", async () => {
    await request(app).get("/api/v1/streams/99999").expect(404);
  });
});
