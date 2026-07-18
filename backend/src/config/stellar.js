const { Networks, rpc, Horizon } = require("@stellar/stellar-sdk");

const NETWORK = process.env.STELLAR_NETWORK || "testnet";

const NETWORK_PASSPHRASES = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const RPC_URLS = {
  mainnet: "https://soroban.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const HORIZON_URLS = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
};

const networkPassphrase =
  process.env.STELLAR_PASSPHRASE ||
  NETWORK_PASSPHRASES[NETWORK] ||
  Networks.TESTNET;

const rpcUrl =
  process.env.STELLAR_RPC_URL || RPC_URLS[NETWORK] || RPC_URLS.testnet;

const horizonUrl =
  process.env.STELLAR_HORIZON_URL ||
  HORIZON_URLS[NETWORK] ||
  HORIZON_URLS.testnet;

const rpcServer = new rpc.Server(rpcUrl, { allowHttp: false });
const horizonServer = new Horizon.Server(horizonUrl);

const CONTRACT_IDS = {
  marketplace: process.env.MARKETPLACE_CONTRACT_ID || "",
  micropayments: process.env.MICROPAYMENTS_CONTRACT_ID || "",
  agentRegistry: process.env.AGENT_REGISTRY_CONTRACT_ID || "",
};

module.exports = {
  NETWORK,
  networkPassphrase,
  rpcUrl,
  horizonUrl,
  rpcServer,
  horizonServer,
  CONTRACT_IDS,
};

// Exported for use in middleware and tests
module.exports.NETWORK_CONFIG = { NETWORK, networkPassphrase, rpcUrl, horizonUrl };
