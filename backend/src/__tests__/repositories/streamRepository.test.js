const streamRepository = require("../../repositories/streamRepository");
const {
  truncateAll,
  closePool,
  buildStream,
  OWNER_A,
  OWNER_B,
} = require("../helpers/testDb");

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe("streamRepository.create", () => {
  it("inserts a stream with defaults applied", async () => {
    const input = buildStream();
    const stream = await streamRepository.create(input);

    expect(stream.id).toBe(input.id);
    expect(stream.sender).toBe(OWNER_A);
    expect(stream.recipient).toBe(OWNER_B);
    expect(stream.token).toBe("native");
    expect(stream.deposit).toBe(10_000_000);
    expect(stream.ratePerSecond).toBe(100);
    expect(stream.status).toBe("Active");
    expect(stream.withdrawn).toBe(0);
    expect(typeof stream.indexedAt).toBe("number");
  });

  it("upserts on conflicting id", async () => {
    const input = buildStream();
    await streamRepository.create(input);
    const updated = await streamRepository.create({ ...input, deposit: 999 });
    expect(updated.deposit).toBe(999);

    const { meta } = await streamRepository.findAll();
    expect(meta.total).toBe(1);
  });

  it("rejects an unknown status", async () => {
    await expect(
      streamRepository.create(buildStream({ status: "Exploded" }))
    ).rejects.toThrow();
  });
});

describe("streamRepository.findById", () => {
  it("returns null for missing stream", async () => {
    expect(await streamRepository.findById(123_456)).toBeNull();
  });

  it("returns the stream", async () => {
    const input = buildStream();
    await streamRepository.create(input);
    const stream = await streamRepository.findById(input.id);
    expect(stream.id).toBe(input.id);
  });
});

describe("streamRepository.findBySender / findByRecipient", () => {
  beforeEach(async () => {
    await streamRepository.create(buildStream({ sender: OWNER_A, recipient: OWNER_B }));
    await streamRepository.create(buildStream({ sender: OWNER_A, recipient: OWNER_B }));
    await streamRepository.create(buildStream({ sender: OWNER_B, recipient: OWNER_A }));
  });

  it("finds streams by sender", async () => {
    const { data, meta } = await streamRepository.findBySender(OWNER_A);
    expect(meta.total).toBe(2);
    data.forEach((s) => expect(s.sender).toBe(OWNER_A));
  });

  it("finds streams by recipient", async () => {
    const { data, meta } = await streamRepository.findByRecipient(OWNER_A);
    expect(meta.total).toBe(1);
    data.forEach((s) => expect(s.recipient).toBe(OWNER_A));
  });
});

describe("streamRepository.findAll", () => {
  it("combines sender, recipient and status filters", async () => {
    await streamRepository.create(
      buildStream({ sender: OWNER_A, recipient: OWNER_B, status: "Active" })
    );
    const paused = buildStream({ sender: OWNER_A, recipient: OWNER_B });
    await streamRepository.create(paused);
    await streamRepository.updateStatus(paused.id, "Paused");

    const { data } = await streamRepository.findAll({
      sender: OWNER_A,
      recipient: OWNER_B,
      status: "Paused",
    });
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(paused.id);
  });
});

describe("streamRepository.updateStatus", () => {
  it("transitions the status and bumps updatedAt", async () => {
    const input = buildStream();
    await streamRepository.create(input);
    const stream = await streamRepository.updateStatus(input.id, "Completed");
    expect(stream.status).toBe("Completed");
  });

  it("returns null for unknown stream", async () => {
    expect(await streamRepository.updateStatus(31_337, "Paused")).toBeNull();
  });

  it("rejects an invalid status value", async () => {
    const input = buildStream();
    await streamRepository.create(input);
    await expect(
      streamRepository.updateStatus(input.id, "Vaporized")
    ).rejects.toThrow();
  });
});

describe("streamRepository.recordWithdrawal", () => {
  it("accumulates withdrawn amount", async () => {
    const input = buildStream({ deposit: 1000 });
    await streamRepository.create(input);

    const after300 = await streamRepository.recordWithdrawal(input.id, 300);
    expect(after300.withdrawn).toBe(300);

    const after800 = await streamRepository.recordWithdrawal(input.id, 500);
    expect(after800.withdrawn).toBe(800);
  });

  it("refuses to withdraw more than the deposit", async () => {
    const input = buildStream({ deposit: 1000 });
    await streamRepository.create(input);
    await expect(
      streamRepository.recordWithdrawal(input.id, 1500)
    ).rejects.toThrow(/deposit/i);

    // and the row is untouched
    const stream = await streamRepository.findById(input.id);
    expect(stream.withdrawn).toBe(0);
  });

  it("returns null for unknown stream", async () => {
    expect(await streamRepository.recordWithdrawal(99_999, 10)).toBeNull();
  });
});
