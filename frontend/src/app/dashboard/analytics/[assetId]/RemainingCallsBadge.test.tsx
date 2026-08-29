import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RemainingCallsBadge from "./RemainingCallsBadge";

describe("RemainingCallsBadge", () => {
  it("renders the value with locale grouping and the sublabel", () => {
    render(<RemainingCallsBadge remaining={12345} sublabel="Across 3 active licenses" />);

    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("Across 3 active licenses")).toBeInTheDocument();
  });

  it("renders zero plainly", () => {
    render(<RemainingCallsBadge remaining={0} sublabel="No active licenses" />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
