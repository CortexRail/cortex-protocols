/**
 * ComplianceExportService — builds a structured data bundle for a data subject.
 *
 * Given a subject identifier (a Stellar public key or agent id), this service
 * collects every data record associated with that subject across all
 * repositories plus the audit log, and returns a structured export bundle
 * suitable for download or delivery to the data subject.
 *
 * # Bundle structure
 * {
 *   subject_id:     string,
 *   generated_at:   ISO-8601 timestamp,
 *   data_sources: {
 *     agents:           Agent[],
 *     assets:           Asset[],
 *     licenses:         License[],
 *     streams:          Stream[],
 *     reports_filed:    Report[],
 *     admin_actions:    AdminAction[],
 *     audit_log:        AuditEntry[],
 *   },
 *   summary: {
 *     total_records: number,
 *     covered_tables: string[],
 *   }
 * }
 *
 * The bundle is persisted in the `compliance_requests` table under
 * `export_bundle` and is available for admin download via the API.
 */

const crypto = require("crypto");
const { query, withTransaction } = require("../db/connection");
const { AuditLogWriter, EVENT_TYPES } = require("./AuditLogWriter");

class ComplianceExportService {
  /**
   * Process a previously-created compliance_request row of type 'export'.
   *
   * @param {number} requestId - Row id in compliance_requests.
   * @returns {Promise<object>} Updated compliance request row.
   */
  async processExport(requestId) {
    // Mark as processing.
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
      const bundle = await this._buildBundle(subjectId);
      const downloadToken = crypto.randomBytes(32).toString("hex");

      const { rows } = await query(
        `UPDATE compliance_requests
         SET status = 'completed',
             result_summary = $2::jsonb,
             export_bundle  = $3::jsonb,
             download_token = $4,
             completed_at   = now()
         WHERE id = $1
         RETURNING *`,
        [
          requestId,
          JSON.stringify(bundle.summary),
          JSON.stringify(bundle),
          downloadToken,
        ]
      );

      // Audit the completion.
      const writer = AuditLogWriter.getInstance();
      await writer.append({
        eventType: EVENT_TYPES.COMPLIANCE_EXPORT_COMPLETED,
        actor: req.requested_by,
        subjectId,
        payload: {
          requestId,
          totalRecords: bundle.summary.total_records,
          downloadToken,
        },
      });

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
   * Build the full export bundle for a subject.
   * @private
   */
  async _buildBundle(subjectId) {
    const [agents, assets, licenses, streams, reportsFiled, adminActions, auditEntries] =
      await Promise.all([
        this._getAgents(subjectId),
        this._getAssets(subjectId),
        this._getLicenses(subjectId),
        this._getStreams(subjectId),
        this._getReportsFiled(subjectId),
        this._getAdminActions(subjectId),
        this._getAuditLog(subjectId),
      ]);

    const allSets = { agents, assets, licenses, streams, reports_filed: reportsFiled, admin_actions: adminActions, audit_log: auditEntries };
    const totalRecords = Object.values(allSets).reduce((s, arr) => s + arr.length, 0);
    const coveredTables = Object.entries(allSets)
      .filter(([, arr]) => arr.length > 0)
      .map(([k]) => k);

    return {
      subject_id: subjectId,
      generated_at: new Date().toISOString(),
      schema_version: "1.0",
      data_sources: allSets,
      summary: {
        total_records: totalRecords,
        covered_tables: coveredTables,
        record_counts: Object.fromEntries(
          Object.entries(allSets).map(([k, v]) => [k, v.length])
        ),
      },
    };
  }

  // ── Data collection helpers ───────────────────────────────────────────────

  async _getAgents(subjectId) {
    const { rows } = await query(
      `SELECT id, owner, name, description, capabilities, reputation,
              total_transactions, is_active, registered_at, indexed_at
       FROM agents WHERE owner = $1`,
      [subjectId]
    );
    return rows;
  }

  async _getAssets(subjectId) {
    const { rows } = await query(
      `SELECT id, owner, name, description, asset_type, license_type,
              price, usage_count, is_active, tags, created_at
       FROM assets WHERE owner = $1`,
      [subjectId]
    );
    return rows;
  }

  async _getLicenses(subjectId) {
    const { rows } = await query(
      `SELECT id, asset_id, buyer, license_type, price_paid,
              calls_remaining, expires_at, is_active, purchased_at
       FROM licenses WHERE buyer = $1`,
      [subjectId]
    );
    return rows;
  }

  async _getStreams(subjectId) {
    const { rows } = await query(
      `SELECT id, sender, recipient, token, deposit, rate_per_second,
              start_time, end_time, status, withdrawn, indexed_at
       FROM streams WHERE sender = $1 OR recipient = $1`,
      [subjectId]
    );
    return rows;
  }

  async _getReportsFiled(subjectId) {
    const { rows } = await query(
      `SELECT id, asset_id, reporter, reason, details, status,
              resolution_note, created_at, resolved_at
       FROM reports WHERE reporter = $1`,
      [subjectId]
    );
    return rows;
  }

  async _getAdminActions(subjectId) {
    // Include admin_actions where the subject appears as the operator
    // OR where their id appears in the args payload.
    const { rows } = await query(
      `SELECT id, operator, role, command, args, status, result,
              created_at, completed_at
       FROM admin_actions
       WHERE operator = $1
          OR args::text ILIKE $2`,
      [subjectId, `%${subjectId}%`]
    );
    return rows;
  }

  async _getAuditLog(subjectId) {
    const writer = AuditLogWriter.getInstance();
    // Also include entries where the subject appears as the actor.
    const { rows } = await query(
      `SELECT id, seq, event_type, actor, subject_id, payload,
              entry_hash, prev_hash, ledger, created_at
       FROM audit_log
       WHERE subject_id = $1 OR actor = $1
       ORDER BY seq ASC`,
      [subjectId]
    );
    return rows.map((r) => ({
      id: r.id,
      seq: Number(r.seq),
      eventType: r.event_type,
      actor: r.actor,
      subjectId: r.subject_id,
      payload: r.payload,
      entryHash: r.entry_hash,
      prevHash: r.prev_hash,
      ledger: r.ledger !== null ? Number(r.ledger) : null,
      createdAt: r.created_at,
    }));
  }
}

module.exports = { ComplianceExportService };
