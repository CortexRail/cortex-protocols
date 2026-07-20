/**
 * Event pipeline orchestrator.
 *
 * This module coordinates durable cursor state, event ingestion, message
 * deduplication, retryable processing, and operational metrics.
 */

const { withTransaction } = require("../db/connection");
const LedgerCursor = require("./LedgerCursor");
const EventPoller = require("./EventPoller");
const EventQueue = require("./EventQueue");
const EventProcessor = require("./EventProcessor");
const EventDeduplicator = require("./EventDeduplicator");
const eventLogRepository = require("../repositories/eventLogRepository");
const pipelineMetrics = require("./pipelineMetrics");

let poller = null;
let queue = null;

function normalizeEvents(events) {
  return Array.isArray(events)
    ? [...events].sort((a, b) => (a.ledger || 0) - (b.ledger || 0))
    : [];
}

async function ingestEvent(event) {
  await withTransaction(async (client) => {
    const duplicate = await EventDeduplicator.isDuplicate(event, client);
    if (duplicate) {
      return;
    }

    await eventLogRepository.append(event, client);
  });

  pipelineMetrics.recordEvent();
  queue.enqueue(event);
}

async function ingestBatch(events = []) {
  const batch = normalizeEvents(events);
  for (const event of batch) {
    await ingestEvent(event);
  }
}

async function stopPipeline() {
  if (poller) {
    poller.stop();
  }
  if (queue) {
    await queue.drainRemaining();
  }
}

async function startPipeline(options = {}) {
  await LedgerCursor.initialize();

  queue = new EventQueue(async (event) => {
    await EventProcessor.process(event);
    await LedgerCursor.persist(event.ledger);
    pipelineMetrics.setLastProcessedLedger(event.ledger);
  }, options.queueOptions);

  poller = new EventPoller(options.pollerOptions);

  await poller.start({
    getStartLedger: () => LedgerCursor.getLastProcessedLedger() + 1,
    onEvents: ingestBatch,
    intervalMs: options.intervalMs,
  });
}

function getMetrics() {
  return pipelineMetrics.getMetrics();
}

function getDeadLetters() {
  return queue ? queue.getDeadLetters() : [];
}

function getStatus() {
  return poller ? poller.getStatus() : { circuitOpen: false };
}

module.exports = {
  startPipeline,
  stopPipeline,
  getMetrics,
  getDeadLetters,
  getStatus,
};
