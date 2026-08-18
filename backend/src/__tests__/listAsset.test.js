const request = require("supertest");
const app = require("../app");
const { mapContractError, enumScVal } = require("../services/listingService");

// A syntactically valid (but unfunded) 56-char testnet public key.
const OWNER = "GCT567RZSD6L247VD3367A54VXQOPZLGXTT5QDM4KFD4QUFNVHZOBGAJ";

const validBody = {
  owner: OWNER,
  name: "Chain-of-Thought Prompt",
  description: "A reasoning prompt that decomposes problems into explicit steps.",
  assetType: "Prompt",
  licenseType: "Perpetual",
  price: "5000000", // stroops
};

describe("POST /api/v1/stellar/list-asset/build — validation", () => {
  it("rejects a missing name", async () => {
    const res = await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, name: "" })
      .expect(422);
    expect(res.body.error).toBe("Validation Error");
  });

  it("rejects a name longer than 200 chars", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, name: "x".repeat(201) })
      .expect(422);
  });

  it("rejects a description longer than 2000 chars", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, description: "x".repeat(2001) })
      .expect(422);
  });

  it("rejects an unknown asset type", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, assetType: "NotAType" })
      .expect(422);
  });

  it("rejects an unknown license type", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, licenseType: "Free" })
      .expect(422);
  });

  it("rejects a zero or negative price", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, price: "0" })
      .expect(422);
  });

  it("rejects a malformed owner key", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send({ ...validBody, owner: "GABC" })
      .expect(422);
  });

  it("returns 503 when the marketplace contract is not configured", async () => {
    // MARKETPLACE_CONTRACT_ID is unset in the test env, so a valid body should
    // pass validation and fail at the contract-configuration check.
    const res = await request(app)
      .post("/api/v1/stellar/list-asset/build")
      .send(validBody)
      .expect(503);
    expect(res.body.error).toMatch(/not configured/i);
  });
});

describe("POST /api/v1/stellar/list-asset/submit — validation", () => {
  it("requires a signedXdr", async () => {
    await request(app)
      .post("/api/v1/stellar/list-asset/submit")
      .send(validBody) // no signedXdr
      .expect(422);
  });
});

describe("mapContractError", () => {
  it("maps a Soroban contract error code to a friendly message + code", () => {
    const err = mapContractError(new Error("HostError: Error(Contract, #5)"));
    expect(err.status).toBe(400);
    expect(err.code).toBe(5);
    expect(err.message).toMatch(/greater than zero/i);
  });

  it("falls back for an unknown code", () => {
    const err = mapContractError(new Error("Error(Contract, #99)"));
    expect(err.code).toBe(99);
    expect(err.message).toMatch(/error #99/);
  });

  it("returns a non-contract error without a code", () => {
    const err = mapContractError(new Error("network unreachable"));
    expect(err.code).toBeUndefined();
    expect(err.message).toMatch(/network unreachable/);
  });
});

describe("enumScVal", () => {
  it("encodes a unit-variant enum as a single-symbol vector", () => {
    const scv = enumScVal("Prompt");
    expect(scv.switch().name).toBe("scvVec");
    const inner = scv.vec();
    expect(inner).toHaveLength(1);
    expect(inner[0].switch().name).toBe("scvSymbol");
    expect(inner[0].sym().toString()).toBe("Prompt");
  });
});
