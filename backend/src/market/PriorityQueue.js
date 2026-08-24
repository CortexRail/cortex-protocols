/**
 * PriorityQueue.js
 * Orders admitted calls by priority tip within a window.
 * Implements an anti-starvation mechanism so low-tip callers are guaranteed
 * execution after waiting for a bounded number of windows.
 */

class PriorityQueue {
  constructor(options = {}) {
    this.maxAgeWindows = options.maxAgeWindows || 5; // Low tips clear within 5 windows max
    this.agingBonusPerWindow = BigInt(options.agingBonusPerWindow || 100);
    this.queue = [];
  }

  /**
   * Enqueues a call request.
   * @param {Object} item
   * @param {string} item.id
   * @param {string} item.agentId
   * @param {bigint|number|string} item.tip
   * @param {number} item.enqueuedWindowId
   * @param {any} [item.payload]
   */
  enqueue(item) {
    const entry = {
      id: item.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      agentId: item.agentId,
      baseTip: BigInt(item.tip || 0),
      enqueuedWindowId: item.enqueuedWindowId,
      payload: item.payload || null,
      enqueuedAt: Date.now(),
    };
    this.queue.push(entry);
    return entry;
  }

  /**
   * Calculates the effective priority tip applying anti-starvation age weight.
   * @param {Object} entry 
   * @param {number} currentWindowId 
   * @returns {bigint}
   */
  getEffectiveTip(entry, currentWindowId) {
    const age = Math.max(0, currentWindowId - entry.enqueuedWindowId);
    if (age >= this.maxAgeWindows) {
      // Force extreme priority to guarantee clearance
      return entry.baseTip + (BigInt(age) * this.agingBonusPerWindow) + 1000000000n;
    }
    return entry.baseTip + (BigInt(age) * this.agingBonusPerWindow);
  }

  /**
   * Drains up to `limit` items sorted by highest effective priority.
   * @param {number} limit 
   * @param {number} currentWindowId 
   * @returns {Array}
   */
  drain(limit, currentWindowId) {
    if (this.queue.length === 0 || limit <= 0) return [];

    this.queue.sort((a, b) => {
      const tipA = this.getEffectiveTip(a, currentWindowId);
      const tipB = this.getEffectiveTip(b, currentWindowId);
      if (tipB > tipA) return 1;
      if (tipB < tipA) return -1;
      return a.enqueuedAt - b.enqueuedAt; // FIFO fallback
    });

    return this.queue.splice(0, limit);
  }

  size() {
    return this.queue.length;
  }

  peek(currentWindowId) {
    if (this.queue.length === 0) return null;
    return [...this.queue].sort((a, b) => {
      const tipA = this.getEffectiveTip(a, currentWindowId);
      const tipB = this.getEffectiveTip(b, currentWindowId);
      return tipB > tipA ? 1 : -1;
    })[0];
  }
}

module.exports = { PriorityQueue };