/**
 * Event processor that forwards contract events to the domain listener while
 * recording latency metrics.
 */

const { processEvent } = require("../listeners/eventListener");
const pipelineMetrics = require("./pipelineMetrics");

async function process(event) {
  const startedAt = Date.now();
  await processEvent(event);
  pipelineMetrics.recordProcessingLatency(Date.now() - startedAt);
}

module.exports = { process };
