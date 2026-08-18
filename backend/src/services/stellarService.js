const {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc,
  scValToNative,
} = require("@stellar/stellar-sdk");

const { rpcServer, networkPassphrase, horizonServer } = require("../config/stellar");

/**
 * Load the latest account from Horizon.
 */
async function loadAccount(publicKey) {
  return horizonServer.loadAccount(publicKey);
}

/**
 * Simulate and submit a Soroban contract invocation.
 *
 * @param {string} contractId  - Deployed contract address
 * @param {string} method      - Function name to call
 * @param {xdr.ScVal[]} args   - Arguments as ScVal array
 * @param {Keypair} signerKeypair - Keypair to sign the transaction
 * @returns {Promise<*>}       Decoded native return value
 */
async function invokeContract(contractId, method, args, signerKeypair) {
  const account = await loadAccount(signerKeypair.publicKey());

  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(signerKeypair);

  const sendResult = await rpcServer.sendTransaction(prepared);

  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  // Poll for confirmation
  let getResult = await rpcServer.getTransaction(sendResult.hash);
  const maxRetries = 12; // ~24s with 2s delay
  let retries = 0;

  while (
    getResult.status === "NOT_FOUND" &&
    retries < maxRetries
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    getResult = await rpcServer.getTransaction(sendResult.hash);
    retries++;
  }

  if (getResult.status !== "SUCCESS") {
    throw new Error(`Transaction status: ${getResult.status}`);
  }

  const returnVal = getResult.returnValue;
  return returnVal ? scValToNative(returnVal) : null;
}

/**
 * Read-only view call (simulation only, no submission).
 */
async function viewContract(contractId, method, args, callerPublicKey) {
  const account = await loadAccount(callerPublicKey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`View call failed: ${simResult.error}`);
  }

  const returnVal = simResult.result?.retval;
  return returnVal ? scValToNative(returnVal) : null;
}

module.exports = { invokeContract, viewContract, loadAccount };
