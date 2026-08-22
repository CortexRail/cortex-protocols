import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AssetDetail from "./AssetDetail";
import type { Asset, License, LicenseListResponse, PurchaseResponse } from "@/types/marketplace";

const BUYER = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";

const mocks = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  isFreighterNotInstalled: vi.fn(),
}));

vi.mock("@/lib/freighter", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/freighter")>();
  return {
    ...mod,
    connectWallet: mocks.connectWallet,
    isFreighterNotInstalled: mocks.isFreighterNotInstalled,
  };
});

const asset: Asset = {
  id: 42,
  owner: "GOWNERADDRESS000000000000000000000000000000000000000000",
  name: "Versioned reasoning asset",
  description: "A marketplace asset with retained versions.",
  assetType: "Prompt",
  licenseType: "Perpetual",
  price: 5_000_000,
  version: 7,
  availableVersions: [3, 4, 5, 6, 7],
  usageCount: 12,
  isActive: true,
  tags: ["reasoning"],
  createdAt: 1,
  indexedAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

const relatedAsset: Asset = { ...asset, id: 43, name: "A sibling prompt asset" };

const emptyLicenses: LicenseListResponse = {
  data: [],
  meta: { total: 0, page: 1, limit: 100, pages: 0 },
};

const purchase: PurchaseResponse = {
  license: {
    id: 9,
    assetId: 42,
    assetVersion: 3,
    buyer: BUYER,
    licenseType: "Perpetual",
    pricePaid: 5_000_000,
    callsRemaining: null,
    expiresAt: null,
    isActive: true,
    purchasedAt: 1,
    updatedAt: 1,
  },
  usageCount: 13,
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function walletConnection(address = BUYER) {
  return { address, network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" };
}

describe("AssetDetail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.connectWallet.mockReset();
    mocks.isFreighterNotInstalled.mockReset().mockReturnValue(false);
  });

  it("renders the current and available versions and defaults to current", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }));

    render(<AssetDetail assetId="42" />);

    expect(await screen.findByText("Current version 7")).toBeDefined();
    const versionOptions = screen.getAllByRole("radio");
    expect(versionOptions).toHaveLength(5);
    expect((screen.getByRole("radio", { name: /Version 7/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("displays price in XLM and the truncated owner address", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }));

    render(<AssetDetail assetId="42" />);

    await screen.findByText("Current version 7");
    expect(screen.getByText("0.5 XLM")).toBeInTheDocument();
    expect(screen.getByText("GOWNER...000000")).toBeInTheDocument();
  });

  it("shows a 404 state for an unknown asset id", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Asset not found" }, 404));

    render(<AssetDetail assetId="999999" />);

    expect(await screen.findByText("Asset not found")).toBeInTheDocument();
    expect(
      screen.getByText("This marketplace asset does not exist or is no longer active.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to marketplace" })).toHaveAttribute(
      "href",
      "/marketplace"
    );
  });

  it("shows a generic error state for a non-404 failure", async () => {
    fetchMock.mockResolvedValueOnce(response({ message: "Database unavailable" }, 500));

    render(<AssetDetail assetId="42" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
  });

  it("renders same-type related assets, excluding the current asset", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(
        response({ data: [asset, relatedAsset], meta: { total: 2, page: 1, limit: 5, pages: 1 } })
      );

    render(<AssetDetail assetId="42" />);

    await screen.findByText("Current version 7");
    expect(await screen.findByRole("link", { name: /A sibling prompt asset/ })).toHaveAttribute(
      "href",
      "/marketplace/43"
    );
    expect(screen.queryByRole("link", { name: /Versioned reasoning asset/ })).toBeNull();
  });

  it("disables the purchase button until a wallet is connected", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }));

    render(<AssetDetail assetId="42" />);

    await screen.findByText("Current version 7");
    expect(
      (screen.getByRole("button", { name: "Connect wallet to purchase" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeInTheDocument();
  });

  it("connects a wallet, fills the buyer, and enables the purchase button", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }))
      .mockResolvedValueOnce(response(emptyLicenses));
    mocks.connectWallet.mockResolvedValue(walletConnection());
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");

    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(await screen.findByText(/Buying as/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Purchase version 7" }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
  });

  it("offers an install link when Freighter is not detected", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }));
    mocks.connectWallet.mockRejectedValue(new Error("Freighter wallet was not detected."));
    mocks.isFreighterNotInstalled.mockReturnValue(true);
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(await screen.findByRole("link", { name: "Install Freighter" })).toBeInTheDocument();
  });

  it("submits a purchase for the connected wallet's address once selected", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }))
      .mockResolvedValueOnce(response(emptyLicenses))
      .mockResolvedValueOnce(response(purchase));
    mocks.connectWallet.mockResolvedValue(walletConnection());
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await screen.findByText(/Buying as/);

    await user.click(await screen.findByRole("radio", { name: "Version 3" }));
    await user.click(screen.getByRole("button", { name: "Purchase version 3" }));

    await screen.findByText("License purchased successfully for version 3.");
    const purchaseCall = fetchMock.mock.calls[3];
    expect(purchaseCall[0]).toContain("/assets/42/purchase");
    expect(JSON.parse((purchaseCall[1] as RequestInit).body as string)).toEqual({
      buyer: BUYER,
      assetVersion: 3,
    });
  });

  it("prevents duplicate submissions while a purchase is pending", async () => {
    let resolvePurchase: ((value: Response) => void) | undefined;
    const pendingPurchase = new Promise<Response>((resolve) => {
      resolvePurchase = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }))
      .mockResolvedValueOnce(response(emptyLicenses))
      .mockReturnValueOnce(pendingPurchase);
    mocks.connectWallet.mockResolvedValue(walletConnection());
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await screen.findByText(/Buying as/);

    const form = screen.getByRole("button", { name: "Purchase version 7" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect((screen.getByRole("button", { name: "Purchasing…" }) as HTMLButtonElement).disabled).toBe(true);

    resolvePurchase?.(response({ ...purchase, license: { ...purchase.license, assetVersion: 7 } }));
    await screen.findByText("License purchased successfully for version 7.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("displays unavailable-version purchase errors", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }))
      .mockResolvedValueOnce(response(emptyLicenses))
      .mockResolvedValueOnce(response({ error: "Asset version 3 is unavailable" }, 400));
    mocks.connectWallet.mockResolvedValue(walletConnection());
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await screen.findByText(/Buying as/);

    await user.click(await screen.findByRole("radio", { name: "Version 3" }));
    await user.click(screen.getByRole("button", { name: "Purchase version 3" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Asset version 3 is unavailable");
  });

  it("shows existing-license status and disables the purchase button when the wallet already owns one", async () => {
    const owned: License = { ...purchase.license, assetVersion: 5, callsRemaining: 10 };
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 5, pages: 0 } }))
      .mockResolvedValueOnce(
        response({ data: [owned], meta: { total: 1, page: 1, limit: 100, pages: 1 } })
      );
    mocks.connectWallet.mockResolvedValue(walletConnection());
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(await screen.findByText(/You already own an active license/)).toHaveTextContent(
      "10 calls remaining"
    );
    expect(
      (screen.getByRole("button", { name: "License already owned" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
