const { query, withTransaction } = require("../db/connection");

const APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function getPolicy(orgId) {
  const res = await query("SELECT * FROM approval_policies WHERE org_id = $1", [orgId]);
  return res.rows[0] || null;
}

async function upsertPolicy(orgId, threshold) {
  const res = await query(
    `INSERT INTO approval_policies (org_id, threshold, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (org_id) DO UPDATE SET threshold = $2, updated_at = now()
     RETURNING *`,
    [orgId, threshold]
  );
  return res.rows[0];
}

async function proposePurchase({ orgId, assetId, assetVersion, buyer, price }) {
  const expiresAt = new Date(Date.now() + APPROVAL_EXPIRY_MS);
  
  const res = await query(
    `INSERT INTO purchase_proposals (org_id, asset_id, asset_version, buyer, price, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [orgId, assetId, assetVersion, buyer, price, expiresAt]
  );
  
  const proposal = res.rows[0];
  
  // E.g. Send notifications to configured signers
  console.log(`[Approval Workflow] Notification: Proposal ${proposal.id} created for org ${orgId}.`);
  
  return proposal;
}

async function listPendingProposals(orgId) {
  const res = await query(
    `SELECT * FROM purchase_proposals WHERE org_id = $1 AND status = 'pending'`,
    [orgId]
  );
  return res.rows;
}

async function recordApproval(proposalId, signer, status) {
  return withTransaction(async (client) => {
    // Check proposal
    const propRes = await client.query(
      "SELECT * FROM purchase_proposals WHERE id = $1 FOR UPDATE",
      [proposalId]
    );
    const proposal = propRes.rows[0];
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status !== "pending") throw new Error(`Proposal is ${proposal.status}`);

    if (new Date() > new Date(proposal.expires_at)) {
      await client.query("UPDATE purchase_proposals SET status = 'expired' WHERE id = $1", [proposalId]);
      throw new Error("Proposal has expired");
    }

    // Insert approval
    await client.query(
      `INSERT INTO proposal_approvals (proposal_id, signer, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (proposal_id, signer) DO UPDATE SET status = $3, created_at = now()`,
      [proposalId, signer, status]
    );

    // If rejected, reject proposal immediately
    if (status === "rejected") {
      await client.query("UPDATE purchase_proposals SET status = 'rejected' WHERE id = $1", [proposalId]);
      proposal.status = "rejected";
      return proposal;
    }

    // Count approvals
    const countRes = await client.query(
      `SELECT count(*) FROM proposal_approvals WHERE proposal_id = $1 AND status = 'approved'`,
      [proposalId]
    );
    const approvedCount = parseInt(countRes.rows[0].count, 10);

    // Get policy threshold
    const policyRes = await client.query(
      "SELECT threshold FROM approval_policies WHERE org_id = $1",
      [proposal.org_id]
    );
    const threshold = policyRes.rows[0]?.threshold || 1;

    if (approvedCount >= threshold) {
      await client.query("UPDATE purchase_proposals SET status = 'approved' WHERE id = $1", [proposalId]);
      proposal.status = "approved";
      // In a full implementation, we might execute the purchase here or wait for the user to submit it on-chain
    }

    return proposal;
  });
}

module.exports = {
  getPolicy,
  upsertPolicy,
  proposePurchase,
  listPendingProposals,
  recordApproval,
};
