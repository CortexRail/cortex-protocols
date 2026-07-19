const { isValidStellarAddress } = require("../../utils/stellar");

describe("isValidStellarAddress", () => {
  // ── Valid ──────────────────────────────────────────────────────────────────

  it("accepts a genuine Ed25519 public key", () => {
    expect(
      isValidStellarAddress(
        "GAOWLGIKI5J7CZIRCIY46MRSILFSXZW4A53SW7DMFNEWLLVYU6PBHK6C"
      )
    ).toBe(true);
  });

  it("accepts another genuine Ed25519 public key", () => {
    expect(
      isValidStellarAddress(
        "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y"
      )
    ).toBe(true);
  });

  // ── Invalid: wrong checksum / wrong key type ────────────────────────────────

  it("rejects a secret seed (S...) even though it is a valid StrKey", () => {
    expect(
      isValidStellarAddress(
        "SCRSAKV7GWCRMUHBYMJBTERBRHREPSOQY4V23ZJGGNZXASYS4D4QXDDA"
      )
    ).toBe(false);
  });

  it("rejects a 56-char string with a corrupted checksum", () => {
    // Flip the last character of a valid key so length/prefix look right
    // but the checksum no longer matches.
    const valid = "GAOWLGIKI5J7CZIRCIY46MRSILFSXZW4A53SW7DMFNEWLLVYU6PBHK6C";
    const corrupted = valid.slice(0, -1) + (valid.endsWith("C") ? "D" : "C");
    expect(isValidStellarAddress(corrupted)).toBe(false);
  });

  it("rejects a lowercased valid key", () => {
    expect(
      isValidStellarAddress(
        "gaowlgiki5j7cziriy46mrsilfsxzw4a53sw7dmfnewllvyu6pbhk6c"
      )
    ).toBe(false);
  });

  // ── Invalid: length / format ─────────────────────────────────────────────

  it("rejects an empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(isValidStellarAddress("GTOOSHORT")).toBe(false);
  });

  it("rejects a string that is too long", () => {
    expect(
      isValidStellarAddress(
        "GAOWLGIKI5J7CZIRCIY46MRSILFSXZW4A53SW7DMFNEWLLVYU6PBHK6CX"
      )
    ).toBe(false);
  });

  it("rejects a key with a valid-looking checksum but padded whitespace", () => {
    expect(
      isValidStellarAddress(
        " GAOWLGIKI5J7CZIRCIY46MRSILFSXZW4A53SW7DMFNEWLLVYU6PBHK6C "
      )
    ).toBe(false);
  });

  it("rejects a 56-char base32 string with a G prefix but no valid checksum", () => {
    expect(
      isValidStellarAddress(
        "GA234567A234567A234567A234567A234567A234567A234567A23456"
      )
    ).toBe(false);
  });

  // ── Invalid: non-string types ────────────────────────────────────────────

  it("rejects null", () => {
    expect(isValidStellarAddress(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidStellarAddress(undefined)).toBe(false);
  });

  it("rejects a number", () => {
    expect(isValidStellarAddress(123)).toBe(false);
  });

  it("rejects an object", () => {
    expect(isValidStellarAddress({ key: "value" })).toBe(false);
  });

  it("rejects an array", () => {
    expect(isValidStellarAddress(["G".repeat(56)])).toBe(false);
  });
});
