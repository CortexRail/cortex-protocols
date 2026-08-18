import { beforeEach, describe, expect, it, vi } from "vitest";

const freighterApi = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => freighterApi);

import { STELLAR_NETWORK } from "./constants";
import {
  FREIGHTER_INSTALL_URL,
  FreighterError,
  FreighterNotInstalledError,
  connectWallet,
  isFreighterNotInstalled,
  networkMatches,
  signWithFreighter,
  truncateAddress,
} from "./freighter";

const ADDRESS = "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y";

describe("truncateAddress", () => {
  it("keeps short keys whole", () => {
    expect(truncateAddress("GABC")).toBe("GABC");
  });

  it("truncates a Stellar public key to 4…4", () => {
    expect(truncateAddress(ADDRESS)).toBe("GDQR…S24Y");
  });
});

describe("FREIGHTER_INSTALL_URL", () => {
  it("points to the Freighter extension site", () => {
    expect(FREIGHTER_INSTALL_URL).toContain("freighter.app");
  });
});

describe("isFreighterNotInstalled", () => {
  it("only matches the dedicated error type", () => {
    expect(isFreighterNotInstalled(new FreighterNotInstalledError("missing"))).toBe(
      true
    );
    expect(isFreighterNotInstalled(new FreighterError("other"))).toBe(false);
    expect(isFreighterNotInstalled("missing")).toBe(false);
    expect(isFreighterNotInstalled(undefined)).toBe(false);
  });
});

describe("networkMatches", () => {
  it("accepts the target network case-insensitively", () => {
    expect(networkMatches(STELLAR_NETWORK)).toBe(true);
    expect(networkMatches(STELLAR_NETWORK.toLowerCase())).toBe(true);
    expect(networkMatches("PUBLIC")).toBe(STELLAR_NETWORK === "PUBLIC");
  });
});

describe("connectWallet", () => {
  beforeEach(() => {
    freighterApi.isConnected.mockReset();
    freighterApi.requestAccess.mockReset();
    freighterApi.getNetwork.mockReset();
  });

  it("throws FreighterNotInstalledError when the extension is missing", async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: false });

    await expect(connectWallet()).rejects.toBeInstanceOf(
      FreighterNotInstalledError
    );
    await expect(connectWallet()).rejects.toMatchObject({ message: /detected/i });
  });

  it("throws a FreighterError when access cannot be granted", async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.requestAccess.mockResolvedValue({
      address: "",
      error: { code: 400, message: "The user denied the request." },
    });

    await expect(connectWallet()).rejects.toThrow("The user denied the request.");
  });

  it("returns the connected address and its network", async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.requestAccess.mockResolvedValue({ address: ADDRESS });
    freighterApi.getNetwork.mockResolvedValue({
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    await expect(connectWallet()).resolves.toEqual({
      address: ADDRESS,
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });
});

describe("signWithFreighter", () => {
  beforeEach(() => {
    freighterApi.signTransaction.mockReset();
  });

  it("returns the signed transaction XDR", async () => {
    freighterApi.signTransaction.mockResolvedValue({
      signedTxXdr: "AAAAAA…",
      error: undefined,
    });

    await expect(
      signWithFreighter("build……", "Test SDF Network ; September 2015", ADDRESS)
    ).resolves.toBe("AAAAAA…");
  });

  it("throws a FreighterError when signing fails", async () => {
    freighterApi.signTransaction.mockResolvedValue({
      signedTxXdr: "",
      error: { code: 400, message: "The user denied the request." },
    });

    await expect(signWithFreighter("build……", "pass", ADDRESS)).rejects.toThrow(
      "The user denied the request."
    );
  });

  it("throws when no signed transaction is returned", async () => {
    freighterApi.signTransaction.mockResolvedValue({
      signedTxXdr: "",
      error: undefined,
    });

    await expect(signWithFreighter("build……", "pass", ADDRESS)).rejects.toThrow(
      "Freighter returned no signed transaction."
    );
  });
});