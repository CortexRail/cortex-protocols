import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AssetDetail from "./AssetDetail";
import type { Asset, PurchaseResponse } from "@/types/marketplace";

const BUYER = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";

const asset: Asset = {
  id: 42,
  owner: "GOWNER",
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

describe("AssetDetail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders the current and available versions and defaults to current", async () => {
    fetchMock.mockResolvedValueOnce(response(asset));

    render(<AssetDetail assetId="42" />);

    expect(await screen.findByText("Current version 7")).toBeDefined();
    const versionOptions = screen.getAllByRole("radio");
    expect(versionOptions).toHaveLength(5);
    expect((screen.getByRole("radio", { name: /Version 7/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("allows only returned versions and submits the selected version", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(response(purchase));
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await user.click(await screen.findByRole("radio", { name: "Version 3" }));
    expect((screen.getByRole("radio", { name: "Version 3" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("radio", { name: "Version 2" })).toBeNull();

    await user.type(screen.getByLabelText("Buyer Stellar address"), BUYER);
    await user.click(screen.getByRole("button", { name: "Purchase version 3" }));

    await screen.findByText("License purchased successfully for version 3.");
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
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
      .mockReturnValueOnce(pendingPurchase);

    render(<AssetDetail assetId="42" />);
    await screen.findByText("Current version 7");
    fireEvent.change(screen.getByLabelText("Buyer Stellar address"), {
      target: { value: BUYER },
    });

    const form = screen.getByRole("button", { name: "Purchase version 7" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("button", { name: "Purchasing…" }) as HTMLButtonElement).disabled).toBe(true);

    resolvePurchase?.(response({
      ...purchase,
      license: { ...purchase.license, assetVersion: 7 },
    }));
    await screen.findByText("License purchased successfully for version 7.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("displays unavailable-version purchase errors", async () => {
    fetchMock
      .mockResolvedValueOnce(response(asset))
      .mockResolvedValueOnce(
        response({ error: "Asset version 3 is unavailable" }, 400)
      );
    const user = userEvent.setup();

    render(<AssetDetail assetId="42" />);
    await user.click(await screen.findByRole("radio", { name: "Version 3" }));
    await user.type(screen.getByLabelText("Buyer Stellar address"), BUYER);
    await user.click(screen.getByRole("button", { name: "Purchase version 3" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Asset version 3 is unavailable"
    );
  });
});
