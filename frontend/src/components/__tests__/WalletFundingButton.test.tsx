import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WalletFundingButton from "../WalletFundingButton";

const VALID_KEY = "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y";

describe("WalletFundingButton", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is not rendered when balance is greater than 0", () => {
    const { container } = render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="testnet"
        balanceXLM={50}
        onFunded={jest.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("is not rendered on Mainnet even with a 0 balance", () => {
    const { container } = render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="mainnet"
        balanceXLM={0}
        onFunded={jest.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("is rendered when connected to Testnet with a 0 balance", () => {
    render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="testnet"
        balanceXLM={0}
        onFunded={jest.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /fund with testnet xlm/i })
    ).toBeInTheDocument();
  });

  it("shows a loading state and disables the button while funding", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    (global.fetch as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const user = userEvent.setup();
    render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="testnet"
        balanceXLM={0}
        onFunded={jest.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /fund with testnet xlm/i }));

    const button = screen.getByRole("button", { name: /funding/i });
    expect(button).toBeDisabled();

    resolveFetch({
      ok: true,
      json: async () => ({ publicKey: VALID_KEY, funded: true, hash: "abc" }),
    });

    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("shows success feedback and calls onFunded after a successful request", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ publicKey: VALID_KEY, funded: true, hash: "abc" }),
    });
    const onFunded = jest.fn();

    const user = userEvent.setup();
    render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="testnet"
        balanceXLM={0}
        onFunded={onFunded}
      />
    );

    await user.click(screen.getByRole("button", { name: /fund with testnet xlm/i }));

    await waitFor(() =>
      expect(screen.getByText(/account funded/i)).toBeInTheDocument()
    );
    expect(onFunded).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when the API call fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Friendbot is only available on Stellar Testnet." }),
    });

    const user = userEvent.setup();
    render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="testnet"
        balanceXLM={0}
        onFunded={jest.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /fund with testnet xlm/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/friendbot is only available on stellar testnet/i)
      ).toBeInTheDocument()
    );
  });

  it("shows a generic error message on a network failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    const user = userEvent.setup();
    render(
      <WalletFundingButton
        publicKey={VALID_KEY}
        network="testnet"
        balanceXLM={0}
        onFunded={jest.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /fund with testnet xlm/i }));

    await waitFor(() =>
      expect(screen.getByText(/unable to reach the funding service/i)).toBeInTheDocument()
    );
  });
});
