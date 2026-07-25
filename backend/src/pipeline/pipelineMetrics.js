/**
 * Runtime metrics for the event pipeline.
 */

const metrics = {
  eventsPerMinute: 0,
  processingLatencyMs: [],
  queueDepth: 0,
  deadLetterCount: 0,
  lastProcessedLedger: 0,
};

let lastEventsAt = Date.now();
let eventsSinceLastMinute = 0;

function recordProcessingLatency(latency) {
  metrics.processingLatencyMs.push(latency);
  if (metrics.processingLatencyMs.length > 1000) {
    metrics.processingLatencyMs.shift();
  }
}

function recordEvent() {
  eventsSinceLastMinute += 1;
  const now = Date.now();
  if (now - lastEventsAt >= 60_000) {
    metrics.eventsPerMinute = eventsSinceLastMinute;
    eventsSinceLastMinute = 0;
    lastEventsAt = now;
  }
}

function setQueueDepth(depth) {
  metrics.queueDepth = depth;
}

function setDeadLetterCount(count) {
  metrics.deadLetterCount = count;
}

function setLastProcessedLedger(ledger) {
  metrics.lastProcessedLedger = ledger;
}

function getMetrics() {
  const sorted = [...metrics.processingLatencyMs].sort((a, b) => a - b);
  const p99Index = Math.floor(sorted.length * 0.99) - 1;
  return {
    events_per_minute: metrics.eventsPerMinute,
    processing_latency_p99:
      sorted.length > 0 ? sorted[Math.max(0, p99Index)] : 0,
    queue_depth: metrics.queueDepth,
    dead_letter_count: metrics.deadLetterCount,
    last_processed_ledger: metrics.lastProcessedLedger,
  };
}

module.exports = {
  recordEvent,
  recordProcessingLatency,
  setQueueDepth,
  setDeadLetterCount,
  setLastProcessedLedger,
  getMetrics,
};
