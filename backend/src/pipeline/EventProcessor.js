/**
 * Event processor that forwards contract events to the domain listener while
 * recording latency metrics.
 *
 * Reputation events (staking, disputes, slashing) are handled here rather than
 * in the asset/agent listener: they carry economic state the index must keep
 * exactly in step with the chain, and each one maps to a single repository
 * write, so a replayed event is idempotent.
 */

const { scValToNative } = require("@stellar/stellar-sdk");

const { processEvent } = require("../listeners/eventListener");
const disputeService = require("../services/disputeService");
const pipelineMetrics = require("./pipelineMetrics");

/** Topics this module owns; everything else falls through to the listener. */
const REPUTATION_TOPICS = new Set([
  "STAKED",
  "UNSTAKED",
  "DISPUTE_OPENED",
  "DISPUTE_VOTED",
  "DISPUTE_RESOLVED",
  "STAKE_SLASHED",
]);

async function process(event) {
  const startedAt = Date.now();

  const topic = topicAt(event, 0);
  if (REPUTATION_TOPICS.has(topic)) {
    await processReputationEvent(topic, event);
  } else {
    await processEvent(event);
  }

  pipelineMetrics.recordProcessingLatency(Date.now() - startedAt);
}

/**
 * Route one reputation event to the dispute service.
 *
 * Topic layouts (see contracts/agent_registry/src/lib.rs):
 *   STAKED            (topic: [tag, agent])                 value: [amount, total]
 *   UNSTAKED          (topic: [tag, agent])                 value: [amount, remaining]
 *   DISPUTE_OPENED    (topic: [tag, complainant, respondent]) value: [id, closesAt]
 *   DISPUTE_VOTED     (topic: [tag, voter])                 value: [id, weight, inFavor]
 *   DISPUTE_RESOLVED  (topic: [tag, respondent])            value: [id, outcome, slashed]
 *   STAKE_SLASHED     (topic: [tag, respondent])            value: [id, slashed]
 */
async function processReputationEvent(topic, event) {
  const value = decode(event.value);
  const ledgerTime = eventTimestamp(event);

  switch (topic) {
    case "STAKED":
    case "UNSTAKED": {
      const agentAddress = topicAt(event, 1);
      const total = numberAt(value, 1);
      if (!agentAddress) return;

      await disputeService.recordStake({
        agentAddress,
        token: event.token || "",
        amount: total,
        stakedAt: ledgerTime,
      });
      return;
    }

    case "DISPUTE_OPENED": {
      const complainant = topicAt(event, 1);
      const respondent = topicAt(event, 2);
      const id = numberAt(value, 0);
      if (!id || !complainant || !respondent) return;

      await disputeService.fileDispute({
        id,
        complainant,
        respondent,
        evidenceHash: event.evidenceHash || "",
        openedAt: ledgerTime,
        closesAt: secondsToMs(numberAt(value, 1)),
      });
      return;
    }

    case "DISPUTE_VOTED": {
      const voter = topicAt(event, 1);
      const id = numberAt(value, 0);
      if (!id || !voter) return;

      await disputeService.recordVote({
        disputeId: id,
        voter,
        weight: numberAt(value, 1),
        inFavor: booleanAt(value, 2),
        votedAt: ledgerTime,
      });
      return;
    }

    case "DISPUTE_RESOLVED": {
      const id = numberAt(value, 0);
      if (!id) return;

      await disputeService.resolveDispute({
        id,
        outcome: outcomeAt(value, 1),
        slashedAmount: numberAt(value, 2),
        resolvedAt: ledgerTime,
      });
      return;
    }

    case "STAKE_SLASHED": {
      const respondent = topicAt(event, 1);
      const slashed = numberAt(value, 1);
      if (!respondent || slashed <= 0) return;

      await disputeService.recordSlash(respondent, slashed);
      return;
    }

    default:
  }
}

// ── Decoding helpers ─────────────────────────────────────────────────────────

function decode(value) {
  if (!value || typeof value.switch !== "function") return value;
  try {
    return scValToNative(value);
  } catch (_err) {
    return value;
  }
}

function topicAt(event, index) {
  const topics = Array.isArray(event?.topic) ? event.topic : [];
  const raw = decode(topics[index]);
  return raw === undefined || raw === null ? null : String(raw);
}

function elementAt(value, index) {
  if (Array.isArray(value)) return value[index];
  if (index === 0) return value;
  return undefined;
}

function numberAt(value, index) {
  const raw = elementAt(value, index);
  if (typeof raw === "bigint") {
    return raw > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(raw);
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanAt(value, index) {
  return Boolean(elementAt(value, index));
}

/** The contract publishes its DisputeOutcome enum as its variant name. */
function outcomeAt(value, index) {
  const raw = elementAt(value, index);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return String(raw[0]);
  if (typeof raw === "object") return String(Object.keys(raw)[0]);
  return String(raw);
}

function secondsToMs(seconds) {
  return seconds > 0 ? seconds * 1000 : null;
}

function eventTimestamp(event) {
  const raw = Number(event?.ledgerClosedAt ? Date.parse(event.ledgerClosedAt) : NaN);
  return Number.isFinite(raw) ? raw : Date.now();
}

module.exports = { process, REPUTATION_TOPICS };
