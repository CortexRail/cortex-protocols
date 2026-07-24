import { Keypair } from "@stellar/stellar-sdk";

export interface SDKConfig {
  backendUrl: string;
  rpcUrl?: string;
  horizonUrl?: string;
  networkPassphrase?: string;
  micropaymentsContractId?: string;
  tokenAddress?: string;
  buyerKeypair: Keypair;
}

export interface StreamObject {
  id: number;
  sender: string;
  recipient: string;
  token: string;
  deposit: number;
  ratePerSecond: number;
  startTime: number;
  endTime: number;
  status: "Active" | "Paused" | "Completed" | "Cancelled";
  withdrawn: number;
  callsRemaining: number;
  callsUsed: number;
  pricePerCall: number;
}

export interface OpenStreamResult {
  streamId: number;
  streamToken: string;
  stream: StreamObject;
}

export interface MeterCallResult {
  calls_remaining: number;
  settle_now: boolean;
}

export default class CortexAgentSDK {
  backendUrl: string;
  buyerKeypair: Keypair;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  micropaymentsContractId?: string;
  tokenAddress: string;

  constructor(config: SDKConfig);

  discover(filters?: {
    assetType?: string;
    licenseType?: string;
    search?: string;
    limit?: number;
  }): Promise<{ data: any[]; meta: any }>;

  getQuote(assetId: number | string): Promise<{
    buyer: string;
    assetId: number;
    price: number;
    expiresAt: number;
    signature: string;
  }>;

  openStream(
    assetId: number | string,
    depositXlm: number,
    durationHours: number
  ): Promise<OpenStreamResult>;

  call(streamToken: string, payload: any): Promise<MeterCallResult>;

  getBalance(streamId: number | string): Promise<number>;

  closeStream(streamId: number | string): Promise<{ txHash?: string; success?: boolean }>;
}
