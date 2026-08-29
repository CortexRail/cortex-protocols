/**
 * CapacityWindow.js
 * Tracks capacity consumption over discrete time/block windows.
 * Implements carry-over mechanics to prevent gaming boundary edge conditions.
 */

class CapacityWindow {
  constructor(windowSizeMs = 60000, maxCapacity = 1000, targetUtilisationRatio = 0.5) {
    this.windowSizeMs = windowSizeMs;
    this.maxCapacity = Number(maxCapacity);
    this.targetCapacity = Math.floor(this.maxCapacity * targetUtilisationRatio);

    this.currentWindowId = null;
    this.windowStartMs = 0;
    this.consumedUnits = 0;
    this.carryOverUnits = 0;
  }

  _resolveWindowId(timestampMs) {
    return Math.floor(timestampMs / this.windowSizeMs);
  }

  /**
   * Advances or initializes window state based on timestamp.
   * @param {number} timestampMs 
   */
  advance(timestampMs = Date.now()) {
    const targetWindowId = this._resolveWindowId(timestampMs);

    if (this.currentWindowId === null) {
      this.currentWindowId = targetWindowId;
      this.windowStartMs = targetWindowId * this.windowSizeMs;
      this.consumedUnits = 0;
      this.carryOverUnits = 0;
      return;
    }

    if (targetWindowId > this.currentWindowId) {
      const windowDiff = targetWindowId - this.currentWindowId;
      
      if (windowDiff === 1) {
        // Carry over up to 10% of overload across immediate 1-step window to prevent boundary burst gaming
        const overload = Math.max(0, (this.consumedUnits + this.carryOverUnits) - this.targetCapacity);
        this.carryOverUnits = Math.floor(overload * 0.1);
      } else {
        this.carryOverUnits = 0;
      }

      this.currentWindowId = targetWindowId;
      this.windowStartMs = targetWindowId * this.windowSizeMs;
      this.consumedUnits = 0;
    }
  }

  /**
   * Attempts to consume capacity within the current window.
   * @param {number} units 
   * @param {number} timestampMs 
   * @returns {{ admitted: boolean, remaining: number, utilisationBps: number }}
   */
  consume(units = 1, timestampMs = Date.now()) {
    this.advance(timestampMs);

    const totalEffective = this.consumedUnits + this.carryOverUnits + units;
    if (totalEffective > this.maxCapacity) {
      return {
        admitted: false,
        remaining: Math.max(0, this.maxCapacity - (this.consumedUnits + this.carryOverUnits)),
        utilisationBps: this.getUtilisationBps(),
      };
    }

    this.consumedUnits += units;
    return {
      admitted: true,
      remaining: this.maxCapacity - (this.consumedUnits + this.carryOverUnits),
      utilisationBps: this.getUtilisationBps(),
    };
  }

  getUtilisationBps() {
    const effectiveConsumed = this.consumedUnits + this.carryOverUnits;
    if (this.maxCapacity === 0) return 0;
    return Math.min(10000, Math.floor((effectiveConsumed / this.maxCapacity) * 10000));
  }

  getState() {
    return {
      windowId: this.currentWindowId,
      windowStartMs: this.windowStartMs,
      maxCapacity: this.maxCapacity,
      targetCapacity: this.targetCapacity,
      consumedUnits: this.consumedUnits,
      carryOverUnits: this.carryOverUnits,
      utilisationBps: this.getUtilisationBps(),
    };
  }
}

module.exports = { CapacityWindow };