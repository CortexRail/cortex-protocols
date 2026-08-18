import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectWalletButton from "../ConnectWalletButton";

import {
  FREIGHTER_INSTALL_URL,
  FreighterError,
  FreighterNotInstalledError,
  truncateAddress,
} from "@/lib/freighter";

const mocks = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  isFreighterNotInstalled: vi.fn(),
}));

vi.mock("@/lib/freighter", async (importOriginal) => {
  const mod = await importOriginal<
    typeof import("@/lib/freighter")
  >();
  return {
    ...mod,
    connectWallet: mocks.connectWallet,
    isFreighterNotInstalled: mocks.isFreighterNotInstalled,
  };
});

const ADDRESS = "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y";

describe("ConnectWalletButton", () => {
  it("shows a Connect Wallet button by default", () => {
    render(<ConnectWalletButton />);
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toBeInTheDocument();
  });

  it("connects and shows the truncated address", async () => {
    const user = userEvent.setup();
    mocks.connectWallet.mockResolvedValue({
      address: ADDRESS,
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    render(<ConnectWalletButton />);
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(await screen.findByText(truncateAddress(ADDRESS))).toBeInTheDocument();
    expect(screen.getByText("Testnet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Disconnect" })
    ).toBeInTheDocument();
  });

  it("disconnects and returns to the connect state", async () => {
    const user = userEvent.setup();
    mocks.connectWallet.mockResolvedValue({
      address: ADDRESS,
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    render(<ConnectWalletButton />);
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await screen.findByText(truncateAddress(ADDRESS));

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toBeInTheDocument();
    expect(screen.queryByText(truncateAddress(ADDRESS))).not.toBeInTheDocument();
  });

  it("offers an install link when Freighter is not installed", async () => {
    const user = userEvent.setup();
    mocks.connectWallet.mockRejectedValue(
      new FreighterNotInstalledError(
        "Freighter wallet was not detected. Install the Freighter browser extension to continue."
      )
    );
    mocks.isFreighterNotInstalled.mockReturnValue(true);

    render(<ConnectWalletButton />);
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/was not detected/i);

    const install = screen.getByRole("link", { name: "Install Freighter" });
    expect(install).toHaveAttribute("href", FREIGHTER_INSTALL_URL);
    expect(install).toHaveAttribute("target", "_blank");
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toBeInTheDocument();
  });

  it("surfaces generic connection errors without an install link", async () => {
    const user = userEvent.setup();
    mocks.connectWallet.mockRejectedValue(
      new FreighterError("The user denied the request.")
    );
    mocks.isFreighterNotInstalled.mockReturnValue(false);

    render(<ConnectWalletButton />);
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The user denied the request."
    );
    expect(screen.queryByRole("link", { name: "Install Freighter" })).toBeNull();
  });

  it("disables the button while connecting", async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => {};
    mocks.connectWallet.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    render(<ConnectWalletButton />);
    await user.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(screen.getByRole("button", { name: /connecting/i })).toBeDisabled();

    release({
      address: ADDRESS,
      network: "TESTNET",
      networkPassphrase: "pass",
    });
    await waitFor(() =>
      expect(screen.getByText(truncateAddress(ADDRESS))).toBeInTheDocument()
    );
  });
});