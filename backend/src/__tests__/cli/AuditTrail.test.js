jest.mock("../../repositories/adminActionRepository", () => ({
  create: jest.fn(),
  complete: jest.fn(),
}));

const adminActionRepository = require("../../repositories/adminActionRepository");
const { withAudit } = require("../../cli/AuditTrail");

const BASE_CALL = { operator: "GOPERATOR", role: "moderator", command: "agent ban", args: { id: 1 } };

describe("AuditTrail.withAudit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminActionRepository.create.mockResolvedValue({ id: 42 });
  });

  it("writes the admin_actions row before the command body runs", async () => {
    const callOrder = [];
    adminActionRepository.create.mockImplementation(async () => {
      callOrder.push("create");
      return { id: 42 };
    });

    await withAudit(BASE_CALL, async () => {
      callOrder.push("command");
      return { ok: true };
    });

    expect(callOrder).toEqual(["create", "command"]);
    expect(adminActionRepository.create).toHaveBeenCalledWith(BASE_CALL);
  });

  it("stamps the row 'success' with the result when the command succeeds", async () => {
    const result = await withAudit(BASE_CALL, async () => ({ banned: true }));

    expect(result).toEqual({ banned: true });
    expect(adminActionRepository.complete).toHaveBeenCalledWith(42, {
      status: "success",
      result: { banned: true },
    });
  });

  it("writes an admin_actions entry even when the underlying command throws", async () => {
    await expect(
      withAudit(BASE_CALL, async () => {
        throw new Error("stream 7 not found");
      })
    ).rejects.toThrow("stream 7 not found");

    expect(adminActionRepository.create).toHaveBeenCalledTimes(1);
    expect(adminActionRepository.complete).toHaveBeenCalledWith(42, {
      status: "error",
      error: "stream 7 not found",
    });
  });

  it("still records the pending->error transition when the command crashes synchronously", async () => {
    await expect(
      withAudit(BASE_CALL, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(adminActionRepository.create).toHaveBeenCalledTimes(1);
    expect(adminActionRepository.complete).toHaveBeenCalledWith(42, {
      status: "error",
      error: "boom",
    });
  });
});
