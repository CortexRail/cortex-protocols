import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TopUpModal from "./TopUpModal";
import { MarketplaceApiError } from "@/lib/marketplace-api";

const mocks = vi.hoisted(() => ({ topUpLicense: vi.fn() }));

vi.mock("@/lib/marketplace-api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/marketplace-api")>();
  return { ...mod, topUpLicense: mocks.topUpLicense };
});

const BUYER = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";

describe("TopUpModal", () => {
  beforeEach(() => {
    mocks.topUpLicense.mockReset();
  });

  it("shows a live cost estimate derived from the asset price", () => {
    render(
      <TopUpModal licenseId={7} buyer={BUYER} assetPrice={10_000_000} onClose={vi.fn()} onSuccess={vi.fn()} />
    );
    // pricePerCall = ceil(10_000_000 / 100) = 100_000; default 50 calls => 5_000_000 stroops = 0.5 XLM
    expect(screen.getByText("0.5 XLM")).toBeInTheDocument();
  });

  it("submits the entered call count and reports the confirmed result", async () => {
    const onSuccess = vi.fn();
    const result = {
      license: { id: 7, callsRemaining: 60 },
      amountCharged: 1_000_000,
      callsAdded: 10,
    };
    mocks.topUpLicense.mockResolvedValue(result);
    const user = userEvent.setup();

    render(
      <TopUpModal licenseId={7} buyer={BUYER} assetPrice={10_000_000} onClose={vi.fn()} onSuccess={onSuccess} />
    );

    const input = screen.getByLabelText("Calls to add");
    await user.clear(input);
    await user.type(input, "10");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mocks.topUpLicense).toHaveBeenCalledWith(7, BUYER, 10);
    expect(onSuccess).toHaveBeenCalledWith(result);
  });

  it("shows an error and does not close on failure", async () => {
    mocks.topUpLicense.mockRejectedValue(new MarketplaceApiError("License is not active", 400));
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <TopUpModal licenseId={7} buyer={BUYER} assetPrice={10_000_000} onClose={vi.fn()} onSuccess={onSuccess} />
    );
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("License is not active");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("disables Confirm while a submission is pending", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.topUpLicense.mockReturnValue(new Promise((r) => { resolve = r; }));

    render(
      <TopUpModal licenseId={7} buyer={BUYER} assetPrice={10_000_000} onClose={vi.fn()} onSuccess={vi.fn()} />
    );

    const form = screen.getByRole("button", { name: "Confirm" }).closest("form");
    fireEvent.submit(form as HTMLFormElement);

    expect(await screen.findByRole("button", { name: "Buying…" })).toBeDisabled();
    resolve({ license: { id: 7, callsRemaining: 100 }, amountCharged: 5_000_000, callsAdded: 50 });
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <TopUpModal licenseId={7} buyer={BUYER} assetPrice={10_000_000} onClose={onClose} onSuccess={vi.fn()} />
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
