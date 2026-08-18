const agentRepository = require("../../repositories/agentRepository");
const { truncateAll, closePool, buildAgent, OWNER_B } = require("../helpers/testDb");

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe("agentRepository.create", () => {
  it("inserts an agent with capabilities as an array", async () => {
    const input = buildAgent({
      capabilities: ["Reasoning", "CodeGeneration"],
    });
    const agent = await agentRepository.create(input);

    expect(agent.id).toBe(input.id);
    expect(agent.capabilities).toEqual(["Reasoning", "CodeGeneration"]);
    expect(agent.reputation).toBe(5000);
    expect(agent.totalTransactions).toBe(0);
    expect(agent.isActive).toBe(true);
    expect(typeof agent.registeredAt).toBe("number");
  });

  it("upserts on conflicting id", async () => {
    const input = buildAgent({ name: "V1" });
    await agentRepository.create(input);
    const v2 = await agentRepository.create({ ...input, name: "V2" });
    expect(v2.name).toBe("V2");

    const { meta } = await agentRepository.findAll();
    expect(meta.total).toBe(1);
  });

  it("rejects out-of-range reputation", async () => {
    await expect(
      agentRepository.create(buildAgent({ reputation: 20_000 }))
    ).rejects.toThrow();
  });
});

describe("agentRepository.findById", () => {
  it("returns null when missing", async () => {
    expect(await agentRepository.findById(777_777)).toBeNull();
  });

  it("returns the agent when present", async () => {
    const input = buildAgent();
    await agentRepository.create(input);
    const agent = await agentRepository.findById(input.id);
    expect(agent.id).toBe(input.id);
  });
});

describe("agentRepository.findAll", () => {
  beforeEach(async () => {
    await agentRepository.create(
      buildAgent({ name: "Alpha", capabilities: ["Reasoning"], reputation: 8000 })
    );
    await agentRepository.create(
      buildAgent({
        name: "Beta",
        capabilities: ["CodeGeneration", "Reasoning"],
        reputation: 9000,
        owner: OWNER_B,
      })
    );
    await agentRepository.create(
      buildAgent({ name: "Gamma", capabilities: ["VisionUnderstanding"], reputation: 4000 })
    );
  });

  it("lists all active agents", async () => {
    const { data, meta } = await agentRepository.findAll();
    expect(data).toHaveLength(3);
    expect(meta.total).toBe(3);
  });

  it("filters by capability using array containment", async () => {
    const { data } = await agentRepository.findAll({ capability: "Reasoning" });
    expect(data).toHaveLength(2);
    data.forEach((a) => expect(a.capabilities).toContain("Reasoning"));
  });

  it("filters by minReputation", async () => {
    const { data } = await agentRepository.findAll({ minReputation: 8500 });
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Beta");
  });

  it("searches name/description case-insensitively", async () => {
    const { data } = await agentRepository.findAll({ search: "alph" });
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Alpha");
  });

  it("paginates deterministically", async () => {
    const page1 = await agentRepository.findAll({}, { page: 1, limit: 2 });
    const page2 = await agentRepository.findAll({}, { page: 2, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(1);
  });

  it("excludes deactivated agents", async () => {
    const victim = buildAgent({ name: "Doomed" });
    await agentRepository.create(victim);
    await agentRepository.deactivate(victim.id);
    const { data } = await agentRepository.findAll();
    expect(data.map((a) => a.name)).not.toContain("Doomed");
  });
});

describe("agentRepository.updateReputation", () => {
  it("sets the new reputation", async () => {
    const input = buildAgent({ reputation: 5000 });
    await agentRepository.create(input);
    const agent = await agentRepository.updateReputation(input.id, 6500);
    expect(agent.reputation).toBe(6500);
  });

  it("returns null for unknown agent", async () => {
    expect(await agentRepository.updateReputation(31_337, 100)).toBeNull();
  });

  it("rejects reputation outside 0..10000", async () => {
    const input = buildAgent();
    await agentRepository.create(input);
    await expect(
      agentRepository.updateReputation(input.id, 10_001)
    ).rejects.toThrow();
  });
});

describe("agentRepository.deactivate", () => {
  it("flips isActive to false", async () => {
    const input = buildAgent();
    await agentRepository.create(input);

    expect(await agentRepository.deactivate(input.id)).toBe(true);

    const agent = await agentRepository.findById(input.id);
    expect(agent.isActive).toBe(false);
  });

  it("returns false for unknown agent", async () => {
    expect(await agentRepository.deactivate(999_999)).toBe(false);
  });
});
