import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TopCallersTable from "./TopCallersTable";
import type { TopCaller } from "@/types/marketplace";

const CALLER: TopCaller = {
  caller: "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC",
  calls: 42,
  revenue: 1_000_000,
  firstSeen: 1_700_000_000_000,
  lastSeen: 1_700_100_000_000,
};

describe("TopCallersTable", () => {
  it("renders one row per caller with truncated address and formatted revenue", () => {
    render(<TopCallersTable callers={[CALLER]} />);

    expect(screen.getByText("GAHC3J...57UYGC")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("0.1 XLM")).toBeInTheDocument();
  });

  it("shows an empty state when there are no callers", () => {
    render(<TopCallersTable callers={[]} />);
    expect(screen.getByText(/no calls recorded/i)).toBeInTheDocument();
  });
});
