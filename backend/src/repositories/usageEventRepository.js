/**
 * Usage event repository — all SQL touching the `usage_events` table.
 *
 * `usage_events` is the per-call metering log the fraud detectors read. Every
 * aggregate a detector needs lives here rather than in `src/fraud/`, keeping
 * the "SQL only in repositories" rule from repoUtils.js intact: the detectors
 * receive plain rows and do the scoring in JavaScript.
 *
 * Window bounds are epoch milliseconds throughout, matching the rest of the
 * repository layer.
 */

const { run, toMs, msParam, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, source, stream_id, license_id, asset_id, caller, counterparty,
  payload_hash, price_paid, occurred_at
`;

/** Subjects a velocity series can be grouped by, mapped to their column. */
const SUBJECT_COLUMNS = Object.freeze({
  asset: "asset_id",
  caller: "caller",
});

function mapUsageEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    streamId: row.stream_id,
    licenseId: row.license_id,
    assetId: row.asset_id,
    caller: row.caller,
    counterparty: row.counterparty,
    payloadHash: row.payload_hash,
    pricePaid: row.price_paid,
    occurredAt: toMs(row.occurred_at),
  };
}

/**
 * Append one metered call.
 *
 * Called on the metering hot path inside the caller's transaction, so it does
 * exactly one INSERT and never reads anything back beyond the new row.
 *
 * @param {object} event
 * @param {"stream"|"license"} event.source
 * @param {string} event.caller - address being billed
 * @param {number} [event.occurredAt] - epoch ms; defaults to the server clock
 */
async function record(event, client) {
  const {
    source,
    streamId = null,
    licenseId = null,
    assetId = null,
    caller,
    counterparty = null,
    payloadHash = null,
    pricePaid = 0,
    occurredAt = null,
  } = event;

  const { rows } = await run(
    `INSERT INTO usage_events
       (source, stream_id, license_id, asset_id, caller, counterparty,
        payload_hash, price_paid, occurred_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8,
        COALESCE(to_timestamp($9::double precision / 1000.0), now()))
     RETURNING ${COLUMNS}`,
    [
      source,
      streamId,
      licenseId,
      assetId,
      caller,
      counterparty,
      payloadHash,
      pricePaid,
      msParam(occurredAt),
    ],
    client
  );
  return mapUsageEvent(rows[0]);
}

/**
 * List raw events, filterable by asset/caller/source and time window.
 * Used by the admin drill-down behind a signal's evidence.
 */
async function findAll(filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);
  const params = [];
  const clauses = [];

  if (filters.assetId !== undefined && filters.assetId !== null) {
    params.push(filters.assetId);
    clauses.push(`asset_id = $${params.length}`);
  }
  if (filters.caller) {
    params.push(filters.caller);
    clauses.push(`caller = $${params.length}`);
  }
  if (filters.counterparty) {
    params.push(filters.counterparty);
    clauses.push(`counterparty = $${params.length}`);
  }
  if (filters.source) {
    params.push(filters.source);
    clauses.push(`source = $${params.length}`);
  }
  if (filters.from !== undefined && filters.from !== null) {
    params.push(msParam(filters.from));
    clauses.push(`occurred_at >= to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (filters.to !== undefined && filters.to !== null) {
    params.push(msParam(filters.to));
    clauses.push(`occurred_at < to_timestamp($${params.length}::double precision / 1000.0)`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM usage_events ${where}`,
    params,
    client,
    "read"
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM usage_events ${where}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
    "read"
  );

  return { data: rows.map(mapUsageEvent), meta: buildMeta(total, page, limit) };
}

/**
 * Call counts per subject per time bucket — the series VelocityDetector runs
 * its rolling z-score over.
 *
 * Buckets are aligned to absolute epoch boundaries (not to the window start)
 * so two scans over overlapping windows produce identical buckets.
 *
 * @param {object} options
 * @param {"asset"|"caller"} [options.subject] - what to group by
 * @param {number} options.from - window start, epoch ms
 * @param {number} options.to - window end, epoch ms
 * @param {number} [options.bucketSeconds] - bucket width (default 1h)
 * @param {number} [options.assetId] - scope to a single asset (subject: "asset" only)
 * @returns {Promise<Array<{subject: string|number, bucketStart: number, calls: number, revenue: number}>>}
 */
async function callCountsByBucket(
  { subject = "asset", from, to, bucketSeconds = 3600, assetId = null } = {},
  client
) {
  const column = SUBJECT_COLUMNS[subject];
  if (!column) {
    throw new Error(`unsupported velocity subject: ${subject}`);
  }
  const width = Math.max(1, Math.trunc(Number(bucketSeconds) || 3600));

  const params = [msParam(from), msParam(to), width];
  let assetFilter = "";
  if (assetId !== null && assetId !== undefined) {
    params.push(assetId);
    assetFilter = `AND asset_id = $${params.length}`;
  }

  const { rows } = await run(
    `SELECT ${column} AS subject,
            to_timestamp(
              (floor(extract(epoch FROM occurred_at) / $3::numeric) * $3::numeric)
                ::double precision
            ) AS bucket_start,
            count(*)::bigint AS calls,
            coalesce(sum(price_paid), 0)::bigint AS revenue
     FROM usage_events
     WHERE occurred_at >= to_timestamp($1::double precision / 1000.0)
       AND occurred_at <  to_timestamp($2::double precision / 1000.0)
       AND ${column} IS NOT NULL
       ${assetFilter}
     GROUP BY subject, bucket_start
     ORDER BY subject, bucket_start`,
    params,
    client,
    "read"
  );

  return rows.map((row) => ({
    subject: row.subject,
    bucketStart: toMs(row.bucket_start),
    calls: Number(row.calls),
    revenue: Number(row.revenue),
  }));
}

/**
 * Per-asset usage split by caller — the input to WashUsageDetector, which
 * compares the share coming from addresses close to the asset owner against
 * the rest.
 *
 * `ownerAddress` rides along so the detector doesn't need a second lookup.
 *
 * @param {number} [options.assetId] - scope to a single asset
 * @returns {Promise<Array<{assetId: number, ownerAddress: string, caller: string,
 *   calls: number, revenue: number, firstSeen: number, lastSeen: number}>>}
 */
async function assetUsageByCaller({ from, to, minAssetCalls = 1, assetId = null } = {}, client) {
  const params = [msParam(from), msParam(to), Math.max(1, Math.trunc(Number(minAssetCalls) || 1))];
  let assetFilter = "";
  if (assetId !== null && assetId !== undefined) {
    params.push(assetId);
    assetFilter = `AND u.asset_id = $${params.length}`;
  }

  const { rows } = await run(
    `WITH windowed AS (
       SELECT u.asset_id, u.caller, u.price_paid, u.occurred_at
       FROM usage_events u
       WHERE u.occurred_at >= to_timestamp($1::double precision / 1000.0)
         AND u.occurred_at <  to_timestamp($2::double precision / 1000.0)
         AND u.asset_id IS NOT NULL
         ${assetFilter}
     ),
     busy AS (
       SELECT asset_id FROM windowed
       GROUP BY asset_id
       HAVING count(*) >= $3
     )
     SELECT w.asset_id,
            a.owner AS owner_address,
            w.caller,
            count(*)::bigint AS calls,
            coalesce(sum(w.price_paid), 0)::bigint AS revenue,
            min(w.occurred_at) AS first_seen,
            max(w.occurred_at) AS last_seen
     FROM windowed w
     JOIN busy b ON b.asset_id = w.asset_id
     LEFT JOIN assets a ON a.id = w.asset_id
     GROUP BY w.asset_id, a.owner, w.caller
     ORDER BY w.asset_id, calls DESC`,
    params,
    client,
    "read"
  );

  return rows.map((row) => ({
    assetId: row.asset_id,
    ownerAddress: row.owner_address,
    caller: row.caller,
    calls: Number(row.calls),
    revenue: Number(row.revenue),
    firstSeen: toMs(row.first_seen),
    lastSeen: toMs(row.last_seen),
  }));
}

/**
 * Payload-repetition statistics per (asset, caller) — ReplayAbuseDetector's
 * input. Calls that carried no payload are excluded entirely, so a client
 * that never sends a body is never flagged.
 *
 * `topHashCalls` is the size of the single most-repeated payload, which is
 * what separates "a few natural repeats" from "one cached response replayed".
 *
 * `sources` tells the detector how the calls were billed: a stream charges
 * per call by construction, so repeats there always avoid payment, while for
 * licence calls it depends on the asset's licence type.
 *
 * @returns {Promise<Array<{assetId: number, caller: string, totalCalls: number,
 *   distinctHashes: number, topHashCalls: number, topHash: string,
 *   sources: string[]}>>}
 */
async function payloadRepetitionStats({ from, to, minCalls = 10 } = {}, client) {
  const { rows } = await run(
    `WITH windowed AS (
       SELECT asset_id, caller, payload_hash, source
       FROM usage_events
       WHERE occurred_at >= to_timestamp($1::double precision / 1000.0)
         AND occurred_at <  to_timestamp($2::double precision / 1000.0)
         AND asset_id IS NOT NULL
         AND payload_hash IS NOT NULL
     ),
     per_hash AS (
       SELECT asset_id, caller, payload_hash, count(*)::bigint AS hash_calls
       FROM windowed
       GROUP BY asset_id, caller, payload_hash
     ),
     call_sources AS (
       SELECT asset_id, caller, array_agg(DISTINCT source) AS sources
       FROM windowed
       GROUP BY asset_id, caller
     ),
     aggregated AS (
       SELECT asset_id,
              caller,
              sum(hash_calls)::bigint AS total_calls,
              count(*)::bigint        AS distinct_hashes,
              max(hash_calls)         AS top_hash_calls
       FROM per_hash
       GROUP BY asset_id, caller
       HAVING sum(hash_calls) >= $3
     )
     SELECT a.asset_id,
            a.caller,
            a.total_calls,
            a.distinct_hashes,
            a.top_hash_calls,
            s.sources,
            (SELECT p.payload_hash
             FROM per_hash p
             WHERE p.asset_id = a.asset_id AND p.caller = a.caller
             ORDER BY p.hash_calls DESC, p.payload_hash
             LIMIT 1) AS top_hash
     FROM aggregated a
     JOIN call_sources s
       ON s.asset_id = a.asset_id AND s.caller = a.caller
     ORDER BY a.asset_id, a.total_calls DESC`,
    [msParam(from), msParam(to), Math.max(1, Math.trunc(Number(minCalls) || 1))],
    client,
    "read"
  );

  return rows.map((row) => ({
    assetId: row.asset_id,
    caller: row.caller,
    totalCalls: Number(row.total_calls),
    distinctHashes: Number(row.distinct_hashes),
    topHashCalls: Number(row.top_hash_calls),
    topHash: row.top_hash,
    sources: row.sources || [],
  }));
}

/**
 * Caller → counterparty edges observed in the window, weighted by call count.
 * One of the three edge sources SybilGraphDetector unions into its graph (the
 * other two are stream sender/recipient pairs and license buyer/owner pairs).
 *
 * @returns {Promise<Array<{from: string, to: string, calls: number,
 *   revenue: number, firstSeen: number, lastSeen: number}>>}
 */
async function edgesInWindow({ from, to, minCalls = 1 } = {}, client) {
  const { rows } = await run(
    `SELECT caller AS from_address,
            counterparty AS to_address,
            count(*)::bigint AS calls,
            coalesce(sum(price_paid), 0)::bigint AS revenue,
            min(occurred_at) AS first_seen,
            max(occurred_at) AS last_seen
     FROM usage_events
     WHERE occurred_at >= to_timestamp($1::double precision / 1000.0)
       AND occurred_at <  to_timestamp($2::double precision / 1000.0)
       AND counterparty IS NOT NULL
       AND counterparty <> caller
     GROUP BY caller, counterparty
     HAVING count(*) >= $3
     ORDER BY calls DESC`,
    [msParam(from), msParam(to), Math.max(1, Math.trunc(Number(minCalls) || 1))],
    client,
    "read"
  );

  return rows.map((row) => ({
    from: row.from_address,
    to: row.to_address,
    calls: Number(row.calls),
    revenue: Number(row.revenue),
    firstSeen: toMs(row.first_seen),
    lastSeen: toMs(row.last_seen),
  }));
}

/**
 * First and last activity per address in the window, with call volume.
 * SybilGraphDetector compares these timings across a cluster: wallets driven
 * by one operator tend to start within minutes of each other.
 *
 * @returns {Promise<Array<{address: string, calls: number,
 *   firstSeen: number, lastSeen: number}>>}
 */
async function activityTimingByAddress({ from, to } = {}, client) {
  const { rows } = await run(
    `SELECT caller AS address,
            count(*)::bigint AS calls,
            min(occurred_at) AS first_seen,
            max(occurred_at) AS last_seen
     FROM usage_events
     WHERE occurred_at >= to_timestamp($1::double precision / 1000.0)
       AND occurred_at <  to_timestamp($2::double precision / 1000.0)
     GROUP BY caller
     ORDER BY first_seen`,
    [msParam(from), msParam(to)],
    client,
    "read"
  );

  return rows.map((row) => ({
    address: row.address,
    calls: Number(row.calls),
    firstSeen: toMs(row.first_seen),
    lastSeen: toMs(row.last_seen),
  }));
}

module.exports = {
  record,
  findAll,
  callCountsByBucket,
  assetUsageByCaller,
  payloadRepetitionStats,
  edgesInWindow,
  activityTimingByAddress,
  SUBJECT_COLUMNS,
};
