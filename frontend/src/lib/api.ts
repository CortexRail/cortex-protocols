import { API_BASE_URL, MARKETPLACE_ERROR_MESSAGES } from "./constants";

/** Error carrying an optional on-chain contract error code for inline display. */
export class ApiError extends Error {
  code?: number;
  status: number;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ListingPayload {
  owner: string;
  name: string;
  description: string;
  assetType: string;
  licenseType: string;
  /** Price in stroops, as a string to preserve precision. */
  price: string;
}

interface BuildResponse {
  xdr: string;
  networkPassphrase: string;
  network: string;
}

interface SubmitResponse {
  hash: string;
  id: number | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "Could not reach the backend. Is the API server running?",
      0
    );
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; code?: number; details?: unknown };
    const code = typeof payload.code === "number" ? payload.code : undefined;
    const message =
      (code && MARKETPLACE_ERROR_MESSAGES[code]) ||
      payload.error ||
      `Request failed (${res.status}).`;
    throw new ApiError(message, res.status, code);
  }

  return data as T;
}

/** Ask the backend to build & simulate the unsigned `list_asset` transaction. */
export function buildListAsset(payload: ListingPayload): Promise<BuildResponse> {
  return postJson<BuildResponse>("/api/v1/stellar/list-asset/build", payload);
}

/** Submit the Freighter-signed transaction; resolves with the new asset id. */
export function submitListAsset(
  payload: ListingPayload & { signedXdr: string }
): Promise<SubmitResponse> {
  return postJson<SubmitResponse>("/api/v1/stellar/list-asset/submit", payload);
}
