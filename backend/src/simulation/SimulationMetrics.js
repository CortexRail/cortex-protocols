/**
 * Metric collection for a simulation run.
 *
 * Records one sample per protocol operation and turns them into latency
 * percentiles, throughput, and an error breakdown. Samples are kept in memory
 * as raw arrays: a bounded swarm run produces tens of thousands of them, which
 * is small enough to sort exactly rather than approximate with a sketch.
 */

/** Operations the harness times. Anything else is recorded under its own key. */
const OPERATIONS = ["handshake", "quote", "streamOpen", "meteredCall", "settlement"];

class SimulationMetrics {
  constructor() {
    /** @type {Map<string, number[]>} operation → latencies in ms */
    this.latencies = new Map();
    /** @type {Map<string, number>} operation → successful sample count */
    this.successes = new Map();
    /** @type {Map<string, Map<string, number>>} operation → error label → count */
    this.errors = new Map();
    this.startedAt = null;
    this.finishedAt = null;
  }

  /** Marks the start of the measured window. */
  start(now = Date.now()) {
    this.startedAt = now;
    return this;
  }

  /** Marks the end of the measured window. */
  finish(now = Date.now()) {
    this.finishedAt = now;
    return this;
  }

  /**
   * Records one completed operation.
   *
   * @param {string} operation - e.g. `"meteredCall"`.
   * @param {number} durationMs
   * @param {{ ok?: boolean, error?: string }} [outcome]
   */
  record(operation, durationMs, outcome = {}) {
    const ok = outcome.ok !== false;

    if (!this.latencies.has(operation)) this.latencies.set(operation, []);
    this.latencies.get(operation).push(durationMs);

    if (ok) {
      this.successes.set(operation, (this.successes.get(operation) ?? 0) + 1);
      return;
    }

    if (!this.errors.has(operation)) this.errors.set(operation, new Map());
    const label = outcome.error || "unknown";
    const bucket = this.errors.get(operation);
    bucket.set(label, (bucket.get(label) ?? 0) + 1);
  }

  /**
   * Times an async operation and records the result either way.
   *
   * @template T
   * @param {string} operation
   * @param {() => Promise<T>} fn
   * @param {() => number} [clock]
   * @returns {Promise<T>}
   */
  async time(operation, fn, clock = Date.now) {
    const started = clock();
    try {
      const result = await fn();
      this.record(operation, clock() - started, { ok: true });
      return result;
    } catch (err) {
      this.record(operation, clock() - started, {
        ok: false,
        error: err?.message ?? String(err),
      });
      throw err;
    }
  }

  /** Total samples recorded across every operation. */
  get totalSamples() {
    let total = 0;
    for (const samples of this.latencies.values()) total += samples.length;
    return total;
  }

  /** Total failed samples across every operation. */
  get totalErrors() {
    let total = 0;
    for (const bucket of this.errors.values()) {
      for (const count of bucket.values()) total += count;
    }
    return total;
  }

  /** Failed samples as a fraction of all samples; `0` when nothing ran. */
  get errorRate() {
    const total = this.totalSamples;
    return total === 0 ? 0 : this.totalErrors / total;
  }

  /** Wall-clock duration of the measured window in milliseconds. */
  get durationMs() {
    if (this.startedAt === null || this.finishedAt === null) return 0;
    return Math.max(0, this.finishedAt - this.startedAt);
  }

  /**
   * Latency percentiles and counts for one operation.
   *
   * @param {string} operation
   * @returns {{ count: number, errors: number, min: number, p50: number, p95: number, p99: number, max: number, mean: number }}
   */
  summarize(operation) {
    const samples = [...(this.latencies.get(operation) ?? [])].sort((a, b) => a - b);
    const errorBucket = this.errors.get(operation);
    let errors = 0;
    if (errorBucket) for (const count of errorBucket.values()) errors += count;

    if (samples.length === 0) {
      return { count: 0, errors, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    }

    const sum = samples.reduce((a, b) => a + b, 0);
    return {
      count: samples.length,
      errors,
      min: samples[0],
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
      max: samples[samples.length - 1],
      mean: Math.round((sum / samples.length) * 100) / 100,
    };
  }

  /** Error label → count, aggregated across every operation. */
  errorBreakdown() {
    const combined = new Map();
    for (const bucket of this.errors.values()) {
      for (const [label, count] of bucket) {
        combined.set(label, (combined.get(label) ?? 0) + count);
      }
    }
    return [...combined.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * The whole run as a plain object, ready to be JSON-encoded or rendered.
   *
   * @returns {object}
   */
  toJSON() {
    const operations = {};
    const seen = new Set([...OPERATIONS, ...this.latencies.keys()]);
    for (const operation of seen) {
      operations[operation] = this.summarize(operation);
    }

    const durationSecs = this.durationMs / 1000;
    return {
      durationMs: this.durationMs,
      totalSamples: this.totalSamples,
      totalErrors: this.totalErrors,
      errorRate: Math.round(this.errorRate * 10000) / 10000,
      throughputPerSec:
        durationSecs > 0 ? Math.round((this.totalSamples / durationSecs) * 100) / 100 : 0,
      operations,
      errorBreakdown: this.errorBreakdown(),
    };
  }
}

/**
 * Nearest-rank percentile over an already-sorted array.
 *
 * @param {number[]} sorted
 * @param {number} fraction - 0..1
 * @returns {number}
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

module.exports = { SimulationMetrics, OPERATIONS, percentile };
