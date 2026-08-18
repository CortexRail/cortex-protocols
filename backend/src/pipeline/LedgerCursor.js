/**
 * Pipeline cursor state.
 *
 * The cursor is persisted in the database so the event pipeline can resume
 * from the last ledger it successfully processed after a restart.
 */

const cursorRepository = require("../repositories/cursorRepository");

let lastProcessedLedger = 0;

async function initialize() {
  lastProcessedLedger = await cursorRepository.getLastProcessedLedger();
  return lastProcessedLedger;
}

function getLastProcessedLedger() {
  return lastProcessedLedger;
}

async function persist(lastLedger, client) {
  if (!Number.isInteger(lastLedger) || lastLedger <= lastProcessedLedger) {
    return lastProcessedLedger;
  }

  await cursorRepository.persistLastProcessedLedger(lastLedger, client);
  lastProcessedLedger = lastLedger;
  return lastProcessedLedger;
}

module.exports = {
  initialize,
  getLastProcessedLedger,
  persist,
};
