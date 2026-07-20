/**
 * Simple in-process queue with retry and dead-letter support.
 */

const pipelineMetrics = require("./pipelineMetrics");

const DEFAULT_MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EventQueue {
  constructor(worker, options = {}) {
    this.worker = worker;
    this.queue = [];
    this.deadLetters = [];
    this.processing = false;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
  }

  enqueue(event) {
    this.queue.push({ event, attempts: 0 });
    pipelineMetrics.setQueueDepth(this.queue.length);
    this.drain().catch((err) => {
      console.error("[EventQueue] drain error:", err.message);
    });
  }

  async drain() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        try {
          item.attempts += 1;
          await this.worker(item.event);
          this.queue.shift();
        } catch (err) {
          if (item.attempts >= this.maxRetries) {
            this.deadLetters.push({
              event: item.event,
              reason: err.message,
              failedAt: new Date().toISOString(),
            });
            this.queue.shift();
            pipelineMetrics.setDeadLetterCount(this.deadLetters.length);
          } else {
            await sleep(100 * item.attempts);
          }
        }
        pipelineMetrics.setQueueDepth(this.queue.length);
      }
    } finally {
      this.processing = false;
    }
  }

  getDeadLetters() {
    return this.deadLetters.slice();
  }

  async drainRemaining() {
    await this.drain();
  }
}

module.exports = EventQueue;
