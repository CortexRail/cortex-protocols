import {
  isConnected,
  requestAccess,
  getNetwork,
  signTransaction,
} from "@stellar/freighter-api";

import { STELLAR_NETWORK } from "./constants";

export class FreighterError extends Error {}

export interface WalletConnection {
  address: string;
  /** Freighter network name, e.g. "PUBLIC" | "TESTNET" | "FUTURENET". */
  network: string;
  networkPassphrase: string;
}

// Freighter returns errors as { code, message, ext? } objects.
type FreighterApiError = { code?: number; message?: string } | undefined;

function messageOf(error: FreighterApiError, fallback: string): string {
  return error?.message || fallback;
}

/** True when the given Freighter network matches the app's target network. */
export function networkMatches(network: string | undefined | null): boolean {
  return !!network && network.toUpperCase() === STELLAR_NETWORK;
}

/**
 * Ensure the Freighter extension is installed and we have access to an account.
 * Returns the connected address plus its active network. The network is *not*
 * enforced here — the UI decides how to handle a mismatch.
 */
export async function connectWallet(): Promise<WalletConnection> {
  const connected = await isConnected();
  if (!connected.isConnected) {
    throw new FreighterError(
      "Freighter wallet was not detected. Install the Freighter browser extension to continue."
    );
  }

  const access = await requestAccess();
  if (access.error || !access.address) {
    throw new FreighterError(
      messageOf(
        access.error,
        "Freighter did not return an account. Approve the connection and try again."
      )
    );
  }

  const net = await getNetwork();
  if (net.error) {
    throw new FreighterError(messageOf(net.error, "Could not read the Freighter network."));
  }

  return {
    address: access.address,
    network: net.network,
    networkPassphrase: net.networkPassphrase,
  };
}

/**
 * Sign a transaction XDR with Freighter and return the signed envelope.
 */
export async function signWithFreighter(
  xdr: string,
  networkPassphrase: string,
  address: string
): Promise<string> {
  const result = await signTransaction(xdr, { networkPassphrase, address });
  if (result.error) {
    throw new FreighterError(
      messageOf(result.error, "Freighter could not sign the transaction.")
    );
  }
  if (!result.signedTxXdr) {
    throw new FreighterError("Freighter returned no signed transaction.");
  }
  return result.signedTxXdr;
}
