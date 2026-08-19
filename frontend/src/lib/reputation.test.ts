import { describe, it, expect } from "vitest";
import {
  BPS_DENOM,
  DEFAULT_DECAY_CONFIG,
  MAX_DECAY_PERIODS,
  currentReputation,
  decayScore,
  formatReputation,
  formatStake,
  outcomeLabel,
  projectCurve,
  reputationTone,
  timeRemaining,
  toPolylinePoints,
  voteShare,
} from "./reputation";

const DAY = 86_400;
const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

describe("decayScore", () => {
  // The contract (contracts/agent_registry/src/lib.rs) and the backend engine
  // assert these same values — all three implementations must agree exactly.
  it("matches the contract's integer decay", () => {
    expect(decayScore(5_000, DAY)).toBe(4_950);
    expect(decayScore(5_000, DAY * 10)).toBe(4_517);
  });

  it("only decays on whole periods", () => {
    expect(decayScore(5_000, DAY - 1)).toBe(5_000);
    expect(decayScore(5_000, 0)).toBe(5_000);
  });

  it("truncates on each period rather than once at the end", () => {
    expect(decayScore(5_000, DAY * 10)).toBeLessThan(Math.floor(5_000 * 0.99 ** 10));
  });

  it("saturates at the contract's iteration bound", () => {
    expect(decayScore(5_000, DAY * 5_000)).toBe(decayScore(5_000, DAY * MAX_DECAY_PERIODS));
  });

  it("never returns a negative score", () => {
    expect(decayScore(-10, DAY)).toBe(0);
    expect(decayScore(0, DAY * 30)).toBe(0);
  });

  it("honours a different on-chain decay rate", () => {
    const config = { ...DEFAULT_DECAY_CONFIG, decayBps: 5_000 };
    expect(decayScore(8_000, DAY * 2, config)).toBe(2_000);
  });

  it("treats a 100% retention rate as decay disabled", () => {
    const config = { ...DEFAULT_DECAY_CONFIG, decayBps: BPS_DENOM };
    expect(decayScore(8_000, DAY * 100, config)).toBe(8_000);
  });
});

describe("currentReputation", () => {
  it("decays from the settlement timestamp", () => {
    expect(currentReputation(5_000, NOW - DAY_MS * 10, NOW)).toBe(4_517);
  });

  it("returns the base score when the clock was never set", () => {
    expect(currentReputation(7_000, null, NOW)).toBe(7_000);
  });
});

describe("formatting", () => {
  it("renders basis points as a percentage", () => {
    expect(formatReputation(4_517)).toBe("45.17%");
    expect(formatReputation(10_000)).toBe("100.00%");
    expect(formatReputation(-5)).toBe("0.00%");
  });

  it("bands a score for colouring", () => {
    expect(reputationTone(9_000)).toBe("high");
    expect(reputationTone(5_000)).toBe("medium");
    expect(reputationTone(1_200)).toBe("low");
  });

  it("renders stroops as trimmed XLM", () => {
    expect(formatStake(10_000_000)).toBe("1");
    expect(formatStake(12_500_000)).toBe("1.25");
    expect(formatStake(0)).toBe("0");
  });

  it("labels every verdict", () => {
    expect(outcomeLabel("guilty")).toBe("Guilty");
    expect(outcomeLabel("not_guilty")).toBe("Not guilty");
    expect(outcomeLabel("quorum_failed")).toBe("No quorum");
    expect(outcomeLabel(null)).toBe("Pending");
  });

  it("counts down to the voting deadline", () => {
    expect(timeRemaining(NOW + DAY_MS * 2 + 3_600_000, NOW)).toBe("2d 1h left");
    expect(timeRemaining(NOW + 7_200_000, NOW)).toBe("2h 0m left");
    expect(timeRemaining(NOW + 60_000, NOW)).toBe("1m left");
    expect(timeRemaining(NOW - 1_000, NOW)).toBe("Voting closed");
    expect(timeRemaining(null, NOW)).toBe("—");
  });
});

describe("voteShare", () => {
  it("is the share of weight cast against the respondent", () => {
    expect(voteShare({ weightFor: 3, weightAgainst: 1 })).toBe(0.75);
    expect(voteShare({ weightFor: 0, weightAgainst: 0 })).toBe(0);
  });
});

describe("chart geometry", () => {
  const box = { width: 100, height: 100, padding: 0 };

  it("maps a flat curve onto a horizontal line", () => {
    const points = projectCurve(
      [
        { timestamp: 0, score: 5_000 },
        { timestamp: 10, score: 5_000 },
      ],
      box
    );
    expect(points).toEqual([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it("puts a higher score higher on the chart", () => {
    const [top, bottom] = projectCurve(
      [
        { timestamp: 0, score: 10_000 },
        { timestamp: 1, score: 0 },
      ],
      box
    );
    expect(top.y).toBe(0);
    expect(bottom.y).toBe(100);
  });

  it("handles a single point without dividing by zero", () => {
    expect(projectCurve([{ timestamp: 5, score: 5_000 }], box)).toEqual([{ x: 0, y: 50 }]);
    expect(projectCurve([], box)).toEqual([]);
  });

  it("respects padding", () => {
    const points = projectCurve(
      [
        { timestamp: 0, score: 10_000 },
        { timestamp: 1, score: 10_000 },
      ],
      { width: 100, height: 100, padding: 10 }
    );
    expect(points[0]).toEqual({ x: 10, y: 10 });
    expect(points[1]).toEqual({ x: 90, y: 10 });
  });

  it("serializes projected points for an SVG polyline", () => {
    expect(
      toPolylinePoints([
        { x: 1.005, y: 2 },
        { x: 3, y: 4 },
      ])
    ).toBe("1,2 3,4");
  });
});
