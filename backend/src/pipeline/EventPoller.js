/**
 * Event poller with exponential backoff, jitter, and a simple circuit breaker.
 */

const { rpcServer, CONTRACT_IDS } = require("../config/stellar");

const MAX_FAILURES = 10;
const COOLDOWN_MS = 60_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 32_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

class EventPoller {
  constructor(options = {}) {
    this.failureCount = 0;
    this.circuitOpenedAt = 0;
    this.isRunning = false;
    this.intervalId = null;
    this.status = {
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
    };
    this.baseDelayMs = Number(options.baseDelayMs) || BASE_DELAY_MS;
    this.maxDelayMs = Number(options.maxDelayMs) || MAX_DELAY_MS;
    this.cooldownMs = Number(options.cooldownMs) || COOLDOWN_MS;
    this.maxFailures = Number(options.maxFailures) || MAX_FAILURES;
  }

  get circuitOpen() {
    return (
      this.circuitOpenedAt > 0 &&
      Date.now() < this.circuitOpenedAt + this.cooldownMs
    );
  }

  recordSuccess() {
    this.failureCount = 0;
    this.circuitOpenedAt = 0;
    this.status = {
      lastError: null,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
    };
  }

  recordFailure(error) {
    this.failureCount += 1;
    this.status.lastError = error.message;
    this.status.consecutiveFailures = this.failureCount;
    if (this.failureCount >= MAX_FAILURES && !this.circuitOpen) {
      this.circuitOpenedAt = Date.now();
      this.status.circuitOpenUntil = new Date(
        this.circuitOpenedAt + COOLDOWN_MS
      ).toISOString();
    }
  }

  getStatus() {
    return { ...this.status, circuitOpen: this.circuitOpen };
  }

  async fetchEvents(startLedger, limit = 100) {
    if (!CONTRACT_IDS.marketplace) {
      return [];
    }

    if (this.circuitOpen) {
      throw new Error("event poller circuit breaker open");
    }

    let attempt = 0;
    while (true) {
      try {
        const response = await rpcServer.getEvents({
          startLedger,
          filters: [
            {
              type: "contract",
              contractIds: [
                CONTRACT_IDS.marketplace,
                CONTRACT_IDS.agentRegistry,
              ].filter(Boolean),
            },
          ],
          limit,
        });

        this.recordSuccess();
        return Array.isArray(response.events) ? response.events : [];
      } catch (error) {
        attempt += 1;
        this.recordFailure(error);

        if (this.circuitOpen) {
          throw error;
        }

        const delay = Math.min(
          this.maxDelayMs,
          this.baseDelayMs * 2 ** Math.min(attempt - 1, 5)
        );
        await sleep(jitter(delay));
      }
    }
  }

  async start({ getStartLedger, onEvents, intervalMs = 5_000 }) {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    const runOnce = async () => {
      if (this.running || !onEvents) return;
      this.running = true;
      try {
        const startLedger = await getStartLedger();
        const events = await this.fetchEvents(startLedger);
        if (events.length > 0) {
          await onEvents(events);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "test") {
          console.warn("[EventPoller] fetch error:", err.message);
        }
      } finally {
        this.running = false;
      }
    };

    this.intervalId = setInterval(runOnce, intervalMs);
    await runOnce();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }
}

module.exports = EventPoller;
