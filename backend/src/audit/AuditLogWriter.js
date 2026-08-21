/**
 * AuditLogWriter — append-only, hash-chained audit log writer.
 *
 * Every audit-relevant event (admin actions, dispute resolutions, moderation
 * decisions, license revocations, compliance requests) is persisted as a row
 * in the `audit_log` table.  Each row's `entry_hash` commits to:
 *
 *   SHA-256( prev_entry_hash || seq || event_type || actor || subject_id || payload )
 *
 * where `prev_entry_hash` is the hash of the immediately preceding row
 * (or the empty string for the genesis entry).  Any retroactive modification
 * to a row will invalidate the hash of every subsequent entry, making
 * tampering detectable by AuditChainVerifier without touching the on-chain
 * anchors.
 *
 * # Thread safety
 * Concurrent appends are serialised at the database level through a
 * PostgreSQL advisory lock on AUDIT_SEQ_LOCK_KEY so that:
 *   1. seq values are contiguous and collision-free
 *   2. each entry's prev_hash correctly references the immediately
 *      preceding entry rather than a stale snapshot.
 *
 * # Usage
 *
 *   const writer = AuditLogWriter.getInstance();
 *
 *   await writer.append({
 *     eventType: 'ADMIN_BAN_AGENT',
 *     actor: 'operator@cortex',
 *     subjectId: String(agentId),
 *     payload: { agentId, reason, bannedBy },
 *   });
 */

const crypto = require("crypto");
const { withTransaction, query } = require("../db/connection");

// Advisory lock key — application-wide constant so every process serialises
// on the same lock regardless of which pool connection wins.
const AUDIT_SEQ_LOCK_KEY = 8472901;

// All recognised audit event types. Adding a new type here keeps the codebase
// consistent and makes grepping straightforward.
const EVENT_TYPES = {
  // Admin / moderation
  ADMIN_ACTION: "ADMIN_ACTION",
  ADMIN_BAN_AGENT: "ADMIN_BAN_AGENT",
  ADMIN_UNBAN_AGENT: "ADMIN_UNBAN_AGENT",
  ADMIN_FLAG_ASSET: "ADMIN_FLAG_ASSET",
  ADMIN_CONTRACT_PAUSE: "ADMIN_CONTRACT_PAUSE",
  ADMIN_CONTRACT_UNPAUSE: "ADMIN_CONTRACT_UNPAUSE",

  // Dispute / moderation report decisions
  REPORT_RESOLVED: "REPORT_RESOLVED",
  REPORT_DISMISSED: "REPORT_DISMISSED",
  REPORT_UNDER_REVIEW: "REPORT_UNDER_REVIEW",

  // Automated fraud detection
  FRAUD_SIGNAL_DISMISSED: "FRAUD_SIGNAL_DISMISSED",

  // License lifecycle
  LICENSE_REVOKED: "LICENSE_REVOKED",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",

  // Compliance
  COMPLIANCE_EXPORT_REQUESTED: "COMPLIANCE_EXPORT_REQUESTED",
  COMPLIANCE_EXPORT_COMPLETED: "COMPLIANCE_EXPORT_COMPLETED",
  COMPLIANCE_ERASURE_REQUESTED: "COMPLIANCE_ERASURE_REQUESTED",
  COMPLIANCE_ERASURE_COMPLETED: "COMPLIANCE_ERASURE_COMPLETED",

  // Chain anchoring
  MERKLE_ANCHOR_SUBMITTED: "MERKLE_ANCHOR_SUBMITTED",
  MERKLE_ANCHOR_CONFIRMED: "MERKLE_ANCHOR_CONFIRMED",

  // Generic
  SYSTEM: "SYSTEM",
};

/**
 * Compute the deterministic SHA-256 entry hash for a log row.
 *
 * The input is a pipe-delimited canonical string to avoid field-boundary
 * ambiguity (the BASE64 encoding of a prior hash never contains `|`).
 *
 * @param {object} params
 * @param {string} params.prevHash   - Base64 hash of the preceding row, or ''.
 * @param {number} params.seq        - Monotonic sequence number of this row.
 * @param {string} params.eventType
 * @param {string} params.actor
 * @param {string} params.subjectId  - Empty string when absent.
 * @param {string} params.payloadJson - Deterministically serialised payload JSON.
 * @returns {string} Base64-encoded SHA-256 digest.
 */
function computeEntryHash({ prevHash, seq, eventType, actor, subjectId, payloadJson }) {
  const input = [prevHash, String(seq), eventType, actor, subjectId || "", payloadJson].join("|");
  return crypto.createHash("sha256").update(input, "utf8").digest("base64");
}

/**
 * Serialize a payload object deterministically (sorted keys).
 * This ensures the same object always produces the same hash regardless
 * of insertion order.
 */
function deterministicJson(obj) {
  if (obj === null || obj === undefined) return "{}";
  if (typeof obj !== "object") return JSON.stringify(obj);

  function sortedStringify(value) {
    if (Array.isArray(value)) return "[" + value.map(sortedStringify).join(",") + "]";
    if (value !== null && typeof value === "object") {
      const sorted = Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + sortedStringify(value[k]));
      return "{" + sorted.join(",") + "}";
    }
    return JSON.stringify(value);
  }

  return sortedStringify(obj);
}

class AuditLogWriter {
  constructor() {
    if (AuditLogWriter._instance) {
      throw new Error("Use AuditLogWriter.getInstance()");
    }
  }

  static getInstance() {
    if (!AuditLogWriter._instance) {
      AuditLogWriter._instance = new AuditLogWriter();
    }
    return AuditLogWriter._instance;
  }

  /**
   * Append one audit entry to the chain.
   *
   * Runs inside a serialised advisory-lock transaction so the sequence number
   * and prev_hash are always consistent even under concurrent writes.
   *
   * @param {object} entry
   * @param {string} entry.eventType  - One of EVENT_TYPES values.
   * @param {string} entry.actor      - Identity of the initiator.
   * @param {string} [entry.subjectId] - Identifier of the affected entity.
   * @param {object} [entry.payload]  - Structured event data (will be stored as JSONB).
   * @param {number} [entry.ledger]   - Ledger number if triggered by an on-chain event.
   * @param {import("pg").PoolClient} [client] - Optional external transaction client.
   * @returns {Promise<AuditEntry>}   The fully-persisted entry.
   */
  async append({ eventType, actor, subjectId = null, payload = {}, ledger = null }, client) {
    if (!eventType || !actor) {
      throw new Error("AuditLogWriter.append: eventType and actor are required");
    }

    const payloadJson = deterministicJson(payload);

    // If a client is provided we use it directly (caller manages the tx).
    // Otherwise we open our own transaction with the advisory lock.
    if (client) {
      return this._appendWithClient(client, { eventType, actor, subjectId, payload, payloadJson, ledger });
    }

    return withTransaction(async (txClient) => {
      // Serialise concurrent appends for this deployment.
      await txClient.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_SEQ_LOCK_KEY]);
      return this._appendWithClient(txClient, { eventType, actor, subjectId, payload, payloadJson, ledger });
    });
  }

  /**
   * Internal: perform the actual INSERT inside an already-open client/tx.
   * @private
   */
  async _appendWithClient(client, { eventType, actor, subjectId, payload: _payload, payloadJson, ledger }) {
    // Fetch current tail of the chain.
    const tailResult = await client.query(
      "SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1"
    );

    const prevRow = tailResult.rows[0] || null;
    const prevSeq = prevRow ? Number(prevRow.seq) : 0;
    const prevHash = prevRow ? prevRow.entry_hash : "";
    const seq = prevSeq + 1;

    const entryHash = computeEntryHash({ prevHash, seq, eventType, actor, subjectId, payloadJson });

    const { rows } = await client.query(
      `INSERT INTO audit_log
         (seq, event_type, actor, subject_id, payload, entry_hash, prev_hash, ledger)
       VALUES
         ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING
         id, seq, event_type, actor, subject_id, payload,
         entry_hash, prev_hash, ledger, created_at`,
      [seq, eventType, actor, subjectId, payloadJson, entryHash, prevHash || null, ledger]
    );

    return mapEntry(rows[0]);
  }

  /**
   * Convenience: append a batch of entries in a single transaction.
   * Entries are inserted in the order provided.
   *
   * @param {Array<object>} entries
   * @returns {Promise<AuditEntry[]>}
   */
  async appendBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_SEQ_LOCK_KEY]);
      const results = [];
      for (const entry of entries) {
        const payloadJson = deterministicJson(entry.payload || {});
        const row = await this._appendWithClient(client, {
          eventType: entry.eventType,
          actor: entry.actor,
          subjectId: entry.subjectId || null,
          payload: entry.payload || {},
          payloadJson,
          ledger: entry.ledger || null,
        });
        results.push(row);
      }
      return results;
    });
  }

  /**
   * Fetch a page of audit entries, newest first.
   *
   * @param {{ page?: number, limit?: number, eventType?: string, actor?: string, subjectId?: string }} filters
   * @returns {Promise<{ data: AuditEntry[], meta: object }>}
   */
  async findRecent(filters = {}) {
    const { page = 1, limit = 50, eventType, actor, subjectId } = filters;
    const safeLimit = Math.min(200, Math.max(1, limit));
    const offset = (Math.max(1, page) - 1) * safeLimit;

    const params = [];
    const clauses = [];

    if (eventType) {
      params.push(eventType);
      clauses.push(`event_type = $${params.length}`);
    }
    if (actor) {
      params.push(actor);
      clauses.push(`actor = $${params.length}`);
    }
    if (subjectId) {
      params.push(subjectId);
      clauses.push(`subject_id = $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const countResult = await query(
      `SELECT count(*)::bigint AS total FROM audit_log ${where}`,
      params
    );
    const total = Number(countResult.rows[0].total);

    params.push(safeLimit, offset);
    const { rows } = await query(
      `SELECT id, seq, event_type, actor, subject_id, payload,
              entry_hash, prev_hash, ledger, created_at
       FROM audit_log ${where}
       ORDER BY seq DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      data: rows.map(mapEntry),
      meta: {
        total,
        page: Math.max(1, page),
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Fetch all audit entries for a given subject, oldest first — used by
   * ComplianceExportService.
   *
   * @param {string} subjectId
   * @returns {Promise<AuditEntry[]>}
   */
  async findBySubject(subjectId) {
    const { rows } = await query(
      `SELECT id, seq, event_type, actor, subject_id, payload,
              entry_hash, prev_hash, ledger, created_at
       FROM audit_log
       WHERE subject_id = $1
       ORDER BY seq ASC`,
      [subjectId]
    );
    return rows.map(mapEntry);
  }

  /**
   * Fetch entries in a seq range [fromSeq, toSeq] inclusive, oldest first.
   * Used by MerkleAnchor to compute tree leaves.
   *
   * @param {number} fromSeq
   * @param {number} toSeq
   * @returns {Promise<AuditEntry[]>}
   */
  async findBySeqRange(fromSeq, toSeq) {
    const { rows } = await query(
      `SELECT id, seq, event_type, actor, subject_id, payload,
              entry_hash, prev_hash, ledger, created_at
       FROM audit_log
       WHERE seq >= $1 AND seq <= $2
       ORDER BY seq ASC`,
      [fromSeq, toSeq]
    );
    return rows.map(mapEntry);
  }

  /**
   * Return the highest seq currently in the log (0 if empty).
   * @returns {Promise<number>}
   */
  async getMaxSeq() {
    const { rows } = await query(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM audit_log"
    );
    return Number(rows[0].max_seq);
  }
}

// Prevent accidental re-construction.
AuditLogWriter._instance = null;

// ── Row mapper ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AuditEntry
 * @property {number} id
 * @property {number} seq
 * @property {string} eventType
 * @property {string} actor
 * @property {string|null} subjectId
 * @property {object} payload
 * @property {string} entryHash
 * @property {string|null} prevHash
 * @property {number|null} ledger
 * @property {number} createdAt - epoch milliseconds
 */

function mapEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: Number(row.seq),
    eventType: row.event_type,
    actor: row.actor,
    subjectId: row.subject_id || null,
    payload: row.payload || {},
    entryHash: row.entry_hash,
    prevHash: row.prev_hash || null,
    ledger: row.ledger !== null && row.ledger !== undefined ? Number(row.ledger) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at),
  };
}

module.exports = {
  AuditLogWriter,
  EVENT_TYPES,
  computeEntryHash,
  deterministicJson,
};
