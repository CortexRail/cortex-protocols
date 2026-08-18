/**
 * AuthGate — every cortex-admin command signs a fresh challenge with the
 * operator's Stellar keypair to prove key possession, then checks the
 * resulting public key against the operator allowlist and the role the
 * command requires.
 *
 * The allowlist is a config file (OPERATOR_ALLOWLIST_PATH, or an inline
 * OPERATOR_ALLOWLIST_PATH JSON array via OPERATOR_ALLOWLIST for tests/CI)
 * of { publicKey, role } entries. An on-chain allowlist can replace this
 * loader later without touching call sites — everything downstream only
 * depends on the { publicKey, role } shape `authenticate` returns.
 */

const fs = require("fs");
const path = require("path");
const { Keypair } = require("@stellar/stellar-sdk");

const ROLE_LEVELS = { readonly: 0, moderator: 1, superadmin: 2 };

const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, "config", "operators.json");

class AuthError extends Error {}

function loadAllowlist(allowlistPath = process.env.OPERATOR_ALLOWLIST_PATH || DEFAULT_ALLOWLIST_PATH) {
  if (process.env.OPERATOR_ALLOWLIST) {
    return JSON.parse(process.env.OPERATOR_ALLOWLIST);
  }
  if (!fs.existsSync(allowlistPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
}

function findOperator(publicKey, allowlist) {
  return allowlist.find((entry) => entry.publicKey === publicKey) || null;
}

function roleSatisfies(role, minRole) {
  return ROLE_LEVELS[role] !== undefined && ROLE_LEVELS[role] >= ROLE_LEVELS[minRole];
}

/**
 * Sign a time-boxed challenge with the operator's secret key, verify the
 * signature, then authorize the resulting public key against the allowlist.
 *
 * @param {object} options
 * @param {string} [options.secretKey] - defaults to OPERATOR_SECRET_KEY
 * @param {'readonly'|'moderator'|'superadmin'} [options.minRole]
 * @param {Array<{publicKey: string, role: string}>} [options.allowlist] - override for tests
 * @returns {{ publicKey: string, role: string }}
 */
function authenticate({ secretKey = process.env.OPERATOR_SECRET_KEY, minRole = "readonly", allowlist } = {}) {
  if (ROLE_LEVELS[minRole] === undefined) {
    throw new AuthError(`unknown role requirement '${minRole}'`);
  }

  if (!secretKey) {
    throw new AuthError("OPERATOR_SECRET_KEY is not set — cannot sign the operator challenge");
  }

  let keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch (err) {
    throw new AuthError(`invalid operator secret key: ${err.message}`);
  }

  const challenge = Buffer.from(`cortex-admin:${Date.now()}:${Math.random()}`);
  const signature = keypair.sign(challenge);
  if (!keypair.verify(challenge, signature)) {
    throw new AuthError("challenge signature verification failed");
  }

  const publicKey = keypair.publicKey();
  const list = allowlist || loadAllowlist();
  const operator = findOperator(publicKey, list);
  if (!operator) {
    throw new AuthError(`operator ${publicKey} is not on the operator allowlist`);
  }

  if (!roleSatisfies(operator.role, minRole)) {
    throw new AuthError(
      `operator ${publicKey} has role '${operator.role}'; this command requires at least '${minRole}'`
    );
  }

  return { publicKey, role: operator.role };
}

module.exports = {
  authenticate,
  loadAllowlist,
  roleSatisfies,
  ROLE_LEVELS,
  AuthError,
};
