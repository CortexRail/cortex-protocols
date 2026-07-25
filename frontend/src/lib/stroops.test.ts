import { describe, it, expect } from "vitest";
import { xlmToStroops, stroopsToXlm } from "./stroops";

describe("xlmToStroops", () => {
  it("converts whole XLM amounts", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
    expect(xlmToStroops("0")).toBe(0n);
    expect(xlmToStroops("100")).toBe(1_000_000_000n);
  });

  it("converts fractional amounts without float error", () => {
    expect(xlmToStroops("0.5")).toBe(5_000_000n);
    expect(xlmToStroops("0.1")).toBe(1_000_000n);
    expect(xlmToStroops("1.2345678")).toBe(12_345_678n);
    // 0.1 + 0.2 would drift in floating point — BigInt math must not.
    expect(xlmToStroops("0.3")).toBe(3_000_000n);
  });

  it("pads trailing decimals to 7 places", () => {
    expect(xlmToStroops("0.0000001")).toBe(1n);
    expect(xlmToStroops("2.5")).toBe(25_000_000n);
  });

  it("trims surrounding whitespace", () => {
    expect(xlmToStroops("  1.5  ")).toBe(15_000_000n);
  });

  it("rejects invalid input", () => {
    expect(() => xlmToStroops("")).toThrow();
    expect(() => xlmToStroops("abc")).toThrow();
    expect(() => xlmToStroops("-1")).toThrow();
    expect(() => xlmToStroops("1.23456789")).toThrow(); // 8 decimals
    expect(() => xlmToStroops("1,5")).toThrow();
    expect(() => xlmToStroops(".5")).toThrow();
  });
});

describe("stroopsToXlm", () => {
  it("formats stroops back into trimmed XLM", () => {
    expect(stroopsToXlm(10_000_000n)).toBe("1");
    expect(stroopsToXlm(5_000_000n)).toBe("0.5");
    expect(stroopsToXlm(12_345_678n)).toBe("1.2345678");
    expect(stroopsToXlm(1n)).toBe("0.0000001");
    expect(stroopsToXlm(0n)).toBe("0");
  });

  it("round-trips with xlmToStroops", () => {
    for (const v of ["0", "1", "0.5", "42.7654321", "1000"]) {
      expect(stroopsToXlm(xlmToStroops(v))).toBe(v);
    }
  });
});
