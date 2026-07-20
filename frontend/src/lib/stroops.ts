import { STROOPS_PER_XLM } from "./constants";

const XLM_PATTERN = /^\d+(\.\d{1,7})?$/;

/**
 * Convert a user-entered XLM amount (as a string) into stroops.
 *
 * Uses integer/BigInt math so there is no floating-point rounding error.
 * Accepts up to 7 decimal places (stroop precision).
 *
 * @throws {Error} if the input is not a valid non-negative XLM amount.
 */
export function xlmToStroops(xlm: string): bigint {
  const trimmed = xlm.trim();
  if (!XLM_PATTERN.test(trimmed)) {
    throw new Error("Enter a valid amount with up to 7 decimal places.");
  }

  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(fracPadded);
}

/**
 * Convert stroops back into a trimmed XLM string (for display).
 */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = abs % STROOPS_PER_XLM;

  const sign = negative ? "-" : "";
  if (frac === 0n) return `${sign}${whole}`;

  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fracStr}`;
}
