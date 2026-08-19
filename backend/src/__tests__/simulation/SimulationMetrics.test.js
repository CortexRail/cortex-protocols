/**
 * Unit tests for latency, throughput and error-rate accounting.
 */

const { SimulationMetrics, percentile } = require("../../simulation/SimulationMetrics");

describe("percentile", () => {
  it("uses nearest-rank over a sorted array", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
  });

  it("returns 0 for an empty sample set", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("SimulationMetrics", () => {
  it("summarizes latency percentiles for one operation", () => {
    const metrics = new SimulationMetrics();
    for (let i = 1; i <= 100; i++) metrics.record("meteredCall", i);

    const summary = metrics.summarize("meteredCall");
    expect(summary.count).toBe(100);
    expect(summary.min).toBe(1);
    expect(summary.p50).toBe(50);
    expect(summary.p95).toBe(95);
    expect(summary.p99).toBe(99);
    expect(summary.max).toBe(100);
    expect(summary.mean).toBe(50.5);
  });

  it("returns a zeroed summary for an operation that never ran", () => {
    expect(new SimulationMetrics().summarize("settlement")).toEqual({
      count: 0, errors: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0,
    });
  });

  it("tracks the error rate across every operation", () => {
    const metrics = new SimulationMetrics();
    for (let i = 0; i < 90; i++) metrics.record("meteredCall", 5);
    for (let i = 0; i < 10; i++) metrics.record("meteredCall", 5, { ok: false, error: "boom" });

    expect(metrics.totalSamples).toBe(100);
    expect(metrics.totalErrors).toBe(10);
    expect(metrics.errorRate).toBeCloseTo(0.1);
  });

  it("is 0% error rate when nothing ran, not NaN", () => {
    expect(new SimulationMetrics().errorRate).toBe(0);
  });

  it("groups errors by label, most frequent first", () => {
    const metrics = new SimulationMetrics();
    metrics.record("quote", 1, { ok: false, error: "timeout" });
    metrics.record("meteredCall", 1, { ok: false, error: "timeout" });
    metrics.record("meteredCall", 1, { ok: false, error: "402" });

    expect(metrics.errorBreakdown()).toEqual([
      { label: "timeout", count: 2 },
      { label: "402", count: 1 },
    ]);
  });

  it("computes throughput from the measured window", () => {
    const metrics = new SimulationMetrics().start(0);
    for (let i = 0; i < 50; i++) metrics.record("meteredCall", 1);
    metrics.finish(10_000);

    const json = metrics.toJSON();
    expect(json.durationMs).toBe(10_000);
    expect(json.throughputPerSec).toBe(5);
  });

  it("times a successful operation and records it", async () => {
    const metrics = new SimulationMetrics();
    let now = 1000;
    const clock = () => now;

    const result = await metrics.time("handshake", async () => {
      now += 42;
      return "done";
    }, clock);

    expect(result).toBe("done");
    expect(metrics.summarize("handshake")).toMatchObject({ count: 1, errors: 0, p50: 42 });
  });

  it("records a failed operation and rethrows", async () => {
    const metrics = new SimulationMetrics();
    let now = 0;
    const clock = () => now;

    await expect(
      metrics.time("streamOpen", async () => {
        now += 7;
        throw new Error("rpc down");
      }, clock)
    ).rejects.toThrow("rpc down");

    expect(metrics.summarize("streamOpen")).toMatchObject({ count: 1, errors: 1 });
    expect(metrics.errorBreakdown()).toEqual([{ label: "rpc down", count: 1 }]);
  });

  it("includes every known operation in its JSON, even unused ones", () => {
    const json = new SimulationMetrics().start(0).finish(1000).toJSON();
    expect(Object.keys(json.operations)).toEqual(
      expect.arrayContaining(["handshake", "quote", "streamOpen", "meteredCall", "settlement"])
    );
  });
});
