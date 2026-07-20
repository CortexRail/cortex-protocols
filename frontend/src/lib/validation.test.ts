import { describe, it, expect } from "vitest";
import { validateListing, type ListingFormValues } from "./validation";

const valid: ListingFormValues = {
  name: "Chain-of-Thought Prompt",
  description: "A reasoning prompt that decomposes problems into explicit steps.",
  assetType: "Prompt",
  licenseType: "Perpetual",
  priceXlm: "0.5",
};

describe("validateListing", () => {
  it("accepts a valid form and returns price in stroops", () => {
    const result = validateListing(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.priceStroops).toBe(5_000_000n);
  });

  it("requires a name", () => {
    const result = validateListing({ ...valid, name: "   " });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it("enforces the 200 char name limit", () => {
    const result = validateListing({ ...valid, name: "x".repeat(201) });
    expect(result.errors.name).toMatch(/200/);
  });

  it("requires a description", () => {
    const result = validateListing({ ...valid, description: "" });
    expect(result.errors.description).toBeDefined();
  });

  it("enforces the 2000 char description limit", () => {
    const result = validateListing({ ...valid, description: "x".repeat(2001) });
    expect(result.errors.description).toMatch(/2000/);
  });

  it("rejects an unknown asset type", () => {
    const result = validateListing({ ...valid, assetType: "NotAType" });
    expect(result.errors.assetType).toBeDefined();
  });

  it("rejects an unknown license type", () => {
    const result = validateListing({ ...valid, licenseType: "Free" });
    expect(result.errors.licenseType).toBeDefined();
  });

  it("rejects an empty price", () => {
    const result = validateListing({ ...valid, priceXlm: "" });
    expect(result.errors.priceXlm).toBeDefined();
  });

  it("rejects a zero price (must be > 0)", () => {
    const result = validateListing({ ...valid, priceXlm: "0" });
    expect(result.errors.priceXlm).toMatch(/greater than zero/i);
    expect(result.priceStroops).toBeUndefined();
  });

  it("rejects a malformed price", () => {
    const result = validateListing({ ...valid, priceXlm: "1.234567890" });
    expect(result.errors.priceXlm).toBeDefined();
  });

  it("reports multiple errors at once", () => {
    const result = validateListing({
      name: "",
      description: "",
      assetType: "",
      licenseType: "",
      priceXlm: "",
    });
    expect(Object.keys(result.errors).sort()).toEqual([
      "assetType",
      "description",
      "licenseType",
      "name",
      "priceXlm",
    ]);
  });
});
