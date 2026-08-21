import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SybilGraphView, { Subgraph } from "./SybilGraphView";

function buildSubgraph(overrides: Partial<Subgraph> = {}): Subgraph {
  return {
    nodes: [
      { address: "GRING0000", degree: 3, count: 12 },
      { address: "GRING0001", degree: 2, count: 8 },
      { address: "GRING0002", degree: 2, count: 6 },
      { address: "GOPERATOR0", degree: 3, count: 20 },
    ],
    edges: [
      { from: "GRING0000", to: "GOPERATOR0", count: 4, sources: ["license"] },
      { from: "GRING0001", to: "GOPERATOR0", count: 2, sources: ["license"] },
      { from: "GRING0002", to: "GOPERATOR0", count: 2, sources: ["license"] },
      { from: "GRING0000", to: "GRING0001", count: 3, sources: ["stream"] },
    ],
    truncated: false,
    totalMembers: 4,
    ...overrides,
  };
}

describe("SybilGraphView", () => {
  it("draws one node and one edge per graph element", () => {
    render(<SybilGraphView subgraph={buildSubgraph()} />);

    expect(screen.getAllByTestId("graph-node")).toHaveLength(4);
    expect(screen.getAllByTestId("graph-edge")).toHaveLength(4);
  });

  it("renders every node inside the viewBox", () => {
    const { container } = render(<SybilGraphView subgraph={buildSubgraph()} width={720} height={420} />);

    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(4);
    circles.forEach((circle) => {
      const cx = Number(circle.getAttribute("cx"));
      const cy = Number(circle.getAttribute("cy"));
      expect(Number.isFinite(cx)).toBe(true);
      expect(Number.isFinite(cy)).toBe(true);
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cx).toBeLessThanOrEqual(720);
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThanOrEqual(420);
    });
  });

  it("highlights the address the operator navigated to", () => {
    const { container } = render(
      <SybilGraphView subgraph={buildSubgraph()} focusAddress="GOPERATOR0" />
    );

    // The highlight is a fill-* utility, not a `fill` attribute — see the note
    // in the component on why the SVG colours had to move into classes.
    const highlighted = container.querySelectorAll("circle.fill-purple-500");
    expect(highlighted).toHaveLength(1);
  });

  it("elides long addresses in labels but leaves short ones intact", () => {
    // Real Stellar addresses are 56 characters; a label that long overlaps its
    // neighbours, so the middle is dropped.
    const realistic = "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT";
    const subgraph = buildSubgraph({
      nodes: [
        { address: realistic, degree: 1, count: 5 },
        { address: "GSHORT", degree: 1, count: 5 },
      ],
      edges: [{ from: realistic, to: "GSHORT", count: 1, sources: ["license"] }],
      totalMembers: 2,
    });

    render(<SybilGraphView subgraph={subgraph} />);

    expect(screen.getByText("GD226Q…PKCT")).toBeInTheDocument();
    expect(screen.getByText("GSHORT")).toBeInTheDocument();
  });

  it("says so when the address has no edges in the window", () => {
    render(<SybilGraphView subgraph={null} />);

    expect(screen.getByTestId("sybil-graph-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("sybil-graph")).not.toBeInTheDocument();
  });

  it("treats an empty node list as nothing to draw", () => {
    render(
      <SybilGraphView subgraph={buildSubgraph({ nodes: [], edges: [], totalMembers: 0 })} />
    );

    expect(screen.getByTestId("sybil-graph-empty")).toBeInTheDocument();
  });

  it("reports how much of a truncated cluster is on screen", () => {
    render(<SybilGraphView subgraph={buildSubgraph({ truncated: true, totalMembers: 120 })} />);

    expect(screen.getByText(/120 addresses/)).toBeInTheDocument();
    expect(screen.getByText(/showing the 4 most connected/)).toBeInTheDocument();
  });

  it("skips edges pointing at nodes outside the trimmed subgraph", () => {
    const subgraph = buildSubgraph();
    subgraph.edges.push({ from: "GRING0000", to: "GNOTRENDERED", count: 1, sources: ["usage"] });

    render(<SybilGraphView subgraph={subgraph} />);

    // The dangling edge is dropped rather than drawn to a missing coordinate.
    expect(screen.getAllByTestId("graph-edge")).toHaveLength(4);
  });
});
