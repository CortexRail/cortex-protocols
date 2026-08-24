import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import CallsChart from "./CallsChart";

const DATA = [
  { bucketStart: 1_700_000_000_000, calls: 10, revenue: 100_000 },
  { bucketStart: 1_700_086_400_000, calls: 25, revenue: 250_000 },
];

describe("CallsChart", () => {
  it("renders one bar per bucket with an accessible label", () => {
    render(<CallsChart data={DATA} bucketSeconds={86_400} />);

    expect(screen.getByRole("button", { name: /10 calls, 0.01 XLM/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /25 calls, 0.025 XLM/ })).toBeInTheDocument();
  });

  it("shows a tooltip with calls and revenue on hover", async () => {
    const user = userEvent.setup();
    render(<CallsChart data={DATA} bucketSeconds={86_400} />);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: /10 calls/ }));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("10 calls");
    expect(tooltip).toHaveTextContent("0.01 XLM");
  });

  it("shows a tooltip on keyboard focus too", async () => {
    const user = userEvent.setup();
    render(<CallsChart data={DATA} bucketSeconds={86_400} />);

    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("10 calls");
  });

  it("renders an empty state with no data", () => {
    render(<CallsChart data={[]} bucketSeconds={86_400} />);
    expect(screen.getByText(/no calls recorded/i)).toBeInTheDocument();
  });
});
