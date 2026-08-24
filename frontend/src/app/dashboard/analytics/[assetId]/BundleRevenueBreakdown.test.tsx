import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import BundleRevenueBreakdown from "./BundleRevenueBreakdown";

describe("BundleRevenueBreakdown", () => {
  it("lists each license type with its revenue and count", () => {
    render(
      <BundleRevenueBreakdown
        data={[
          { licenseType: "UsageBased", licenseCount: 3, revenue: 600_000 },
          { licenseType: "Perpetual", licenseCount: 1, revenue: 400_000 },
        ]}
        totalRevenue={1_000_000}
      />
    );

    expect(screen.getByText("UsageBased")).toBeInTheDocument();
    expect(screen.getByText("(3 licenses)")).toBeInTheDocument();
    expect(screen.getByText("Perpetual")).toBeInTheDocument();
    expect(screen.getByText("(1 license)")).toBeInTheDocument();
    expect(screen.getByText("0.1 XLM")).toBeInTheDocument(); // totalRevenue header
  });

  it("shows an empty state when there is no revenue yet", () => {
    render(<BundleRevenueBreakdown data={[]} totalRevenue={0} />);
    expect(screen.getByText(/no revenue recorded/i)).toBeInTheDocument();
  });
});
