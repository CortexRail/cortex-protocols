jest.mock("../../repositories/agentRepository", () => ({
  create: jest.fn(),
  updateReputation: jest.fn(),
}));

jest.mock("../../repositories/agentBanRepository", () => ({
  isBanned: jest.fn(),
}));

const agentRepository = require("../../repositories/agentRepository");
const agentBanRepository = require("../../repositories/agentBanRepository");
const { registerAgent, submitReputation } = require("../../services/agentService");

describe("agentService ban enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registerAgent rejects a banned agent id without touching the repository", async () => {
    agentBanRepository.isBanned.mockResolvedValue(true);

    await expect(registerAgent({ id: 7, owner: "GOWNER", name: "Bot" })).rejects.toThrow(/banned/);
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  it("registerAgent proceeds when the agent isn't banned", async () => {
    agentBanRepository.isBanned.mockResolvedValue(false);
    agentRepository.create.mockResolvedValue({ id: 7 });

    await registerAgent({ id: 7, owner: "GOWNER", name: "Bot" });
    expect(agentRepository.create).toHaveBeenCalledTimes(1);
  });

  it("submitReputation rejects a banned agent without touching the repository", async () => {
    agentBanRepository.isBanned.mockResolvedValue(true);

    await expect(submitReputation(7, 60, "GVOTER")).rejects.toThrow(/banned/);
    expect(agentRepository.updateReputation).not.toHaveBeenCalled();
  });
});
