import { Suspense } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AssetAnalyticsPage from "./page";
import type { Asset, License } from "@/types/marketplace";

const OWNER = "GOWNERADDRESS0000000000000000000000000000000000000000000";
const BUYER = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";

const mocks = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  isFreighterNotInstalled: vi.fn(),
}));

vi.mock("@/lib/freighter", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/freighter")>();
  return { ...mod, connectWallet: mocks.connectWallet, isFreighterNotInstalled: mocks.isFreighterNotInstalled };
});

const ASSET: Asset = {
  id: 42,
  owner: OWNER,
  name: "Reasoning Chain Pro",
  description: "A test asset.",
  assetType: "ReasoningChain",
  licenseType: "UsageBased",
  price: 10_000_000,
  version: 1,
  availableVersions: [1],
  usageCount: 5,
  isActive: true,
  tags: [],
  createdAt: 1,
  indexedAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function walletConnection(address: string) {
  return { address, network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" };
}

function pageProps() {
  return { params: Promise.resolve({ assetId: "42" }) };
}

// `use(params)` suspends on the first render even for an already-resolved
// promise, and needs both a Suspense boundary and an async act() so React
// gets a turn to retry after the promise settles.
async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={<p>Loading…</p>}>
        <AssetAnalyticsPage {...pageProps()} />
      </Suspense>
    );
  });
}

describe("AssetAnalyticsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.connectWallet.mockReset();
    mocks.isFreighterNotInstalled.mockReset().mockReturnValue(false);
  });

  it("shows a 404 state for an unknown asset", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Asset not found" }, 404));
    await renderPage();
    expect(await screen.findByText("Asset not found")).toBeInTheDocument();
  });

  it("prompts to connect a wallet before showing any analytics", async () => {
    fetchMock.mockResolvedValueOnce(response(ASSET));
    await renderPage();

    expect(await screen.findByText(/connect your wallet to view analytics/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeInTheDocument();
  });

  describe("owner view", () => {
    it("fetches and renders usage, top callers, revenue, and remaining calls", async () => {
      fetchMock
        .mockResolvedValueOnce(response(ASSET))
        .mockResolvedValueOnce(
          response({ data: [{ bucketStart: 1_700_000_000_000, calls: 10, revenue: 100_000 }], from: 0, to: 0, bucketSeconds: 86_400 })
        )
        .mockResolvedValueOnce(
          response({
            data: [{ caller: BUYER, calls: 10, revenue: 100_000, firstSeen: 1, lastSeen: 2 }],
            from: 0,
            to: 0,
          })
        )
        .mockResolvedValueOnce(
          response({ data: [{ licenseType: "UsageBased", licenseCount: 1, revenue: 100_000 }], totalRevenue: 100_000 })
        )
        .mockResolvedValueOnce(response({ activeLicenseCount: 1, totalRemaining: 90 }));
      mocks.connectWallet.mockResolvedValue(walletConnection(OWNER));
      const user = userEvent.setup();

      await renderPage();
      await user.click(await screen.findByRole("button", { name: "Connect Wallet" }));

      expect(await screen.findByText("90")).toBeInTheDocument(); // remaining calls badge
      expect(screen.getByText(/across 1 active usage-based license/i)).toBeInTheDocument();
      expect(screen.getByText("UsageBased")).toBeInTheDocument(); // revenue breakdown row
      expect(screen.getByRole("button", { name: /10 calls/ })).toBeInTheDocument(); // chart bar
      expect(screen.getByText("GAHC3J...57UYGC")).toBeInTheDocument(); // top callers table

      expect(fetchMock.mock.calls[1][0]).toContain("/assets/42/usage");
      expect(fetchMock.mock.calls[2][0]).toContain("/assets/42/top-callers");
      expect(fetchMock.mock.calls[3][0]).toContain("/assets/42/revenue-breakdown");
      expect(fetchMock.mock.calls[4][0]).toContain("/assets/42/remaining-calls");
    });
  });

  describe("buyer view", () => {
    const LICENSE: License = {
      id: 9,
      assetId: 42,
      assetVersion: 1,
      buyer: BUYER,
      licenseType: "UsageBased",
      pricePaid: 1_000_000,
      callsRemaining: 30,
      expiresAt: null,
      isActive: true,
      purchasedAt: 1,
      updatedAt: 1,
    };

    it("shows the buyer's own remaining calls and a top-up button when they hold a license", async () => {
      fetchMock
        .mockResolvedValueOnce(response(ASSET))
        .mockResolvedValueOnce(response({ data: [LICENSE], meta: { total: 1, page: 1, limit: 100, pages: 1 } }));
      mocks.connectWallet.mockResolvedValue(walletConnection(BUYER));
      const user = userEvent.setup();

      await renderPage();
      await user.click(await screen.findByRole("button", { name: "Connect Wallet" }));

      expect(await screen.findByText("30")).toBeInTheDocument();
      expect(screen.getByText("Your remaining calls on this license")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Buy more calls" }));
      expect(screen.getByText(/Add calls to license #9/)).toBeInTheDocument();
    });

    it("tells an unrelated wallet that analytics are owner-only", async () => {
      fetchMock
        .mockResolvedValueOnce(response(ASSET))
        .mockResolvedValueOnce(response({ data: [], meta: { total: 0, page: 1, limit: 100, pages: 0 } }));
      mocks.connectWallet.mockResolvedValue(walletConnection(BUYER));
      const user = userEvent.setup();

      await renderPage();
      await user.click(await screen.findByRole("button", { name: "Connect Wallet" }));

      expect(await screen.findByText(/visible to its owner/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Buy more calls" })).toBeNull();
    });
  });
});
