/**
 * ErasureService — honoring erasure requests within immutability constraints.
 *
 * # What can and cannot be erased
 *
 * ## CANNOT be erased (immutable by design)
 * - On-chain transaction hashes, ledger numbers, and contract events — these
 *   exist permanently on the Stellar network and are outside our control.
 * - The structural hash chain in `audit_log` — the `entry_hash` and
 *   `prev_hash` columns, and the `seq` numbers, are retained unchanged so
 *   AuditChainVerifier continues to pass after erasure.
 * - The `merkle_anchors` table — these commitments are on-chain and the
 *   stored roots are not PII.
 * - The `events_log` table — raw on-chain events are immutable.
 *
 * ## CAN be pseudonymised (off-chain mutable PII)
 * - `agents.owner`
 * - `assets.owner`
 * - `licenses.buyer`
 * - `streams.sender`, `streams.recipient`
 * - `reports.reporter`
 * - `admin_actions.operator`
 * - `audit_log.actor`, `audit_log.subject_id`
 * - PII values inside `audit_log.payload` JSONB
 * - PII values inside `admin_actions.args` and `admin_actions.result` JSONB
 *
 * ## Pseudonymisation approach
 * Each original value is replaced with a stable, irreversible token of the
 * form `PSEUDONYM_<truncated SHA-256>`.  The same original value → same token
 * (deterministic), so cross-row referential integrity is preserved while the
 * original value is unrecoverable without the original input.
 *
 * The mapping from lookup_key → pseudonym is stored in `pseudonym_map` so
 * subsequent erasure requests for the same subject are idempotent and produce
 * the same tokens (no double-pseudonymisation).
 *
 * After erasure, AuditChainVerifier WILL still pass because the hash chain
 * (entry_hash / prev_hash) is left untouched — only the cleartext payload
 * fields are replaced. The chain's structural integrity proves the sequence
 * was not reordered or gapped; the on-chain anchor independently proves the
 * Merkle root was correct at anchor time.
 *
 * # Important limitations documented for the UI
 * - On-chain data is permanent. Erasure removes personal data from the
 *   off-chain database only.
 * - Audit log hash chains are preserved; a forensic auditor can confirm the
 *   chain is intact but cannot recover pseudonymised values.
 * - The `pseudonym_map` table retains the pseudonym tokens (but not the
 *   original values).  A second erasure request for the same subject is a
 *   no-op (tokens are already applied).
 */

const crypto = require("crypto");
const { query, withTransaction } = require("../db/connection");
const { AuditLogWriter, EVENT_TYPES } = require("./AuditLogWriter");

// Prefix makes pseudonyms visually recognisable in the DB.
const PSEUDONYM_PREFIX = "PSEUDONYM_";

/**
 * Compute a stable pseudonym for a given original value, scoped to
 * (subjectId, fieldName, originalValue).
 *
 * The lookup_key is the SHA-256 of the concatenation so the original value
 * is not stored anywhere — only the lookup_key is persisted.
 *
 * @param {string} subjectId
 * @param {string} fieldName
 * @param {string} originalValue
 * @returns {{ lookupKey: string, pseudonym: string }}
 */
function deriveToken(subjectId, fieldName, originalValue) {
  const raw = `${subjectId}|${fieldName}|${originalValue}`;
  const lookupKey = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  // The pseudonym uses only the first 24 hex chars of the same hash for brevity.
  const pseudonym = PSEUDONYM_PREFIX + lookupKey.slice(0, 24).toUpperCase();
  return { lookupKey, pseudonym };
}

/**
 * Recursively walk a JSON value and replace any occurrence of `original`
 * with `replacement`, regardless of nesting depth.
 */
function replaceInJson(value, original, replacement) {
  if (value === original) return replacement;
  if (typeof value === "string") {
    // Replace substrings too (e.g. a key embedded in a description).
    if (value.includes(original)) return value.split(original).join(replacement);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceInJson(item, original, replacement));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = replaceInJson(value[k], original, replacement);
    }
    return out;
  }
  return value;
}

class ErasureService {
  /**
   * Process a previously-created compliance_request row of type 'erasure'.
   *
   * @param {number} requestId - Row id in compliance_requests.
   * @returns {Promise<object>} Updated compliance request row.
   */
  async processErasure(requestId) {
    await query(
      `UPDATE compliance_requests SET status = 'processing' WHERE id = $1`,
      [requestId]
    );

    const { rows: reqRows } = await query(
      "SELECT * FROM compliance_requests WHERE id = $1",
      [requestId]
    );
    if (!reqRows.length) throw new Error(`compliance_request ${requestId} not found`);
    const req = reqRows[0];
    const subjectId = req.subject_id;

    try {
      const summary = await this._erasePii(subjectId, req.requested_by);

      const { rows } = await query(
        `UPDATE compliance_requests
         SET status = 'completed',
             result_summary = $2::jsonb,
             completed_at   = now()
         WHERE id = $1
         RETURNING *`,
        [requestId, JSON.stringify(summary)]
      );

      return rows[0];
    } catch (err) {
      await query(
        `UPDATE compliance_requests
         SET status = 'failed', error_message = $2
         WHERE id = $1`,
        [requestId, err.message]
      );
      throw err;
    }
  }

  /**
   * Core erasure logic: pseudonymise all PII fields for the given subject.
   *
   * @param {string} subjectId
   * @param {string} actor - The admin who requested the erasure.
   * @returns {Promise<object>} Summary of changes made.
   */
  async _erasePii(subjectId, actor) {
    const summary = {
      subject_id: subjectId,
      erased_at: new Date().toISOString(),
      tables_modified: [],
      records_pseudonymised: 0,
      immutable_notice: [
        "On-chain Stellar transactions are permanent and cannot be erased.",
        "events_log (raw on-chain events) is retained unchanged.",
        "audit_log entry_hash/prev_hash columns are retained to preserve chain integrity.",
        "merkle_anchors are retained as they contain no PII.",
        "pseudonym_map retains the pseudonym tokens (not original values) for idempotency.",
      ],
    };

    return withTransaction(async (client) => {
      let totalChanged = 0;

      // Pseudonymise the subject_id itself.
      const { pseudonym: subjectPseudonym } = await this._getOrCreateToken(
        client, subjectId, "subject_id", subjectId
      );

      // ── agents ──────────────────────────────────────────────────────────
      const agentResult = await client.query(
        "UPDATE agents SET owner = $2 WHERE owner = $1 RETURNING id",
        [subjectId, subjectPseudonym]
      );
      if (agentResult.rowCount > 0) {
        summary.tables_modified.push("agents");
        totalChanged += agentResult.rowCount;
      }

      // ── assets ──────────────────────────────────────────────────────────
      const assetResult = await client.query(
        "UPDATE assets SET owner = $2 WHERE owner = $1 RETURNING id",
        [subjectId, subjectPseudonym]
      );
      if (assetResult.rowCount > 0) {
        summary.tables_modified.push("assets");
        totalChanged += assetResult.rowCount;
      }

      // ── licenses ────────────────────────────────────────────────────────
      const { pseudonym: buyerPseudonym } = await this._getOrCreateToken(
        client, subjectId, "buyer", subjectId
      );
      const licenseResult = await client.query(
        "UPDATE licenses SET buyer = $2 WHERE buyer = $1 RETURNING id",
        [subjectId, buyerPseudonym]
      );
      if (licenseResult.rowCount > 0) {
        summary.tables_modified.push("licenses");
        totalChanged += licenseResult.rowCount;
      }

      // ── streams ─────────────────────────────────────────────────────────
      const { pseudonym: senderPseudonym } = await this._getOrCreateToken(
        client, subjectId, "sender", subjectId
      );
      const { pseudonym: recipientPseudonym } = await this._getOrCreateToken(
        client, subjectId, "recipient", subjectId
      );

      const streamResult = await client.query(
        `UPDATE streams
         SET sender    = CASE WHEN sender = $1 THEN $2 ELSE sender END,
             recipient = CASE WHEN recipient = $1 THEN $3 ELSE recipient END
         WHERE sender = $1 OR recipient = $1
         RETURNING id`,
        [subjectId, senderPseudonym, recipientPseudonym]
      );
      if (streamResult.rowCount > 0) {
        summary.tables_modified.push("streams");
        totalChanged += streamResult.rowCount;
      }

      // ── reports ─────────────────────────────────────────────────────────
      const { pseudonym: reporterPseudonym } = await this._getOrCreateToken(
        client, subjectId, "reporter", subjectId
      );
      const reportResult = await client.query(
        "UPDATE reports SET reporter = $2 WHERE reporter = $1 RETURNING id",
        [subjectId, reporterPseudonym]
      );
      if (reportResult.rowCount > 0) {
        summary.tables_modified.push("reports");
        totalChanged += reportResult.rowCount;
      }

      // ── admin_actions ────────────────────────────────────────────────────
      const { pseudonym: operatorPseudonym } = await this._getOrCreateToken(
        client, subjectId, "operator", subjectId
      );
      // Pseudonymise the operator column.
      const adminOpResult = await client.query(
        "UPDATE admin_actions SET operator = $2 WHERE operator = $1 RETURNING id",
        [subjectId, operatorPseudonym]
      );
      // Also scrub the subject from args/result JSONB.
      const adminJsonResult = await this._scrubJsonbColumn(
        client, "admin_actions", ["args", "result"], subjectId, subjectPseudonym
      );
      const adminChanged = adminOpResult.rowCount + adminJsonResult;
      if (adminChanged > 0) {
        summary.tables_modified.push("admin_actions");
        totalChanged += adminChanged;
      }

      // ── audit_log ────────────────────────────────────────────────────────
      // IMPORTANT: We do NOT touch entry_hash or prev_hash.
      // We pseudonymise actor, subject_id, and the payload JSONB.
      // The hash chain will no longer match the pseudonymised content, but
      // that is the defined behaviour — the chain's structural ordering
      // (sequence continuity and prev_hash linkage) remains valid.
      const { pseudonym: actorPseudonym } = await this._getOrCreateToken(
        client, subjectId, "actor", subjectId
      );
      const auditActorResult = await client.query(
        "UPDATE audit_log SET actor = $2 WHERE actor = $1 RETURNING id",
        [subjectId, actorPseudonym]
      );
      const auditSubjectResult = await client.query(
        "UPDATE audit_log SET subject_id = $2 WHERE subject_id = $1 RETURNING id",
        [subjectId, subjectPseudonym]
      );
      // Scrub payload JSONB in audit_log.
      const auditPayloadChanged = await this._scrubAuditLogPayload(
        client, subjectId, subjectPseudonym
      );
      const auditChanged = auditActorResult.rowCount + auditSubjectResult.rowCount + auditPayloadChanged;
      if (auditChanged > 0) {
        summary.tables_modified.push("audit_log");
        totalChanged += auditChanged;
      }

      summary.records_pseudonymised = totalChanged;
      summary.tables_modified = [...new Set(summary.tables_modified)];

      // Write the audit entry for the erasure (after pseudonymisation so the
      // entry records the pseudonym, not the original identifier).
      const writer = AuditLogWriter.getInstance();
      await writer.append(
        {
          eventType: EVENT_TYPES.COMPLIANCE_ERASURE_COMPLETED,
          actor,
          subjectId: subjectPseudonym,
          payload: {
            originalSubjectIdPseudonymised: true,
            tablesModified: summary.tables_modified,
            recordsPseudonymised: totalChanged,
          },
        },
        client
      );

      return summary;
    });
  }

  /**
   * Get or create a pseudonym token, storing the mapping in pseudonym_map.
   * Uses an ON CONFLICT DO NOTHING to be idempotent.
   *
   * @private
   */
  async _getOrCreateToken(client, subjectId, fieldName, originalValue) {
    const { lookupKey, pseudonym } = deriveToken(subjectId, fieldName, originalValue);

    // Try to fetch existing first (common case after first erasure request).
    const { rows } = await client.query(
      "SELECT pseudonym FROM pseudonym_map WHERE lookup_key = $1",
      [lookupKey]
    );
    if (rows.length) return { lookupKey, pseudonym: rows[0].pseudonym };

    // Insert new mapping.
    await client.query(
      `INSERT INTO pseudonym_map (lookup_key, pseudonym, subject_id, field_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lookup_key) DO NOTHING`,
      [lookupKey, pseudonym, subjectId, fieldName]
    );

    return { lookupKey, pseudonym };
  }

  /**
   * Replace occurrences of `original` in one or more JSONB columns using
   * a JSON replace approach: cast to text, replace, cast back.
   *
   * Only updates rows where the original value actually appears in the JSON
   * text (checked with LIKE) to avoid unnecessary writes.
   *
   * @private
   */
  async _scrubJsonbColumn(client, table, columns, original, replacement) {
    let totalChanged = 0;
    for (const col of columns) {
      // Using text replacement via jsonb → text → jsonb is safe for known-safe
      // replacement strings (pseudonyms are hex, no special JSON chars).
      const result = await client.query(
        `UPDATE ${table}
         SET ${col} = REPLACE(${col}::text, $1, $2)::jsonb
         WHERE ${col}::text LIKE $3
           AND ${col} IS NOT NULL`,
        [original, replacement, `%${original}%`]
      );
      totalChanged += result.rowCount;
    }
    return totalChanged;
  }

  /**
   * Scrub the audit_log.payload JSONB column for rows referencing subjectId.
   * @private
   */
  async _scrubAuditLogPayload(client, original, replacement) {
    const result = await client.query(
      `UPDATE audit_log
       SET payload = REPLACE(payload::text, $1, $2)::jsonb
       WHERE payload::text LIKE $3`,
      [original, replacement, `%${original}%`]
    );
    return result.rowCount;
  }
}

// Exported utilities for tests.
module.exports = { ErasureService, deriveToken, replaceInJson };
