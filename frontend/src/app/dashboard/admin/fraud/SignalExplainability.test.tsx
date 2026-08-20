import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SignalExplainability, { FraudSignal } from "./SignalExplainability";

const COMPOSITE_EXPLANATION = [
  "Risk CRITICAL (score 1.00) for asset 42 (owner/actor GSELLER).",
  "3 detectors fired:",
  "• wash_usage scored 0.98 (weight 1.5): 94.1% of asset 42's 340 calls came from 8 addresses tied to the owner.",
  "• sybil_graph scored 0.76 (weight 1.5): 9 addresses transact as one connected cluster.",
  "Corroboration: 3 independent detectors agreed, raising the weighted mean of 0.90 by 30%.",
].join("\n");

function buildSignal(overrides: Partial<FraudSignal> = {}): FraudSignal {
  return {
    id: 1,
    detector: "composite",
    agentAddress: "GSELLER00000000000000000000000000000000000000000000000000",
    assetId: 42,
    score: 1,
    riskTier: "critical",
    explanation: COMPOSITE_EXPLANATION,
    evidence: {
      base: 0.9,
      corroboration: 1.3,
      detectorCount: 3,
      weights: { velocity: 1, sybil_graph: 1.5, wash_usage: 1.5, replay_abuse: 1 },
      signals: [
        {
          detector: "wash_usage",
          rawScore: 0.98,
          weight: 1.5,
          contribution: 1.47,
          summary: "94.1% of asset 42's calls came from addresses tied to the owner.",
          metrics: { totalCalls: 340, insiderCalls: 320, callShare: 0.9412 },
        },
        {
          detector: "sybil_graph",
          rawScore: 0.76,
          weight: 1.5,
          contribution: 1.14,
          summary: "9 addresses transact as one connected cluster.",
          metrics: { clusterSize: 9, density: 0.4444 },
        },
      ],
    },
    status: "open",
    reportId: null,
    dismissedBy: null,
    dismissReason: null,
    windowStart: 1_700_000_000_000,
    windowEnd: 1_700_086_400_000,
    createdAt: 1_700_086_400_000,
    asset: { id: 42, name: "Reasoning Chain", owner: "GSELLER" },
    ...overrides,
  };
}

describe("SignalExplainability", () => {
  it("leads with the human-readable explanation, never a bare score", () => {
    render(<SignalExplainability signal={buildSignal()} />);

    const explanation = screen.getByTestId("signal-explanation");
    expect(explanation.textContent).toContain("Risk CRITICAL");
    expect(explanation.textContent).toContain("3 detectors fired");
    expect(explanation.textContent).toContain("wash_usage scored 0.98");
    // Not just a number.
    expect(explanation.textContent!.trim()).not.toMatch(/^[\d.]+$/);
  });

  it("breaks down every detector that contributed", () => {
    render(<SignalExplainability signal={buildSignal()} />);

    const parts = screen.getAllByTestId("detector-part");
    expect(parts).toHaveLength(2);
    expect(screen.getByText("wash_usage")).toBeInTheDocument();
    expect(screen.getByText("sybil_graph")).toBeInTheDocument();
    expect(screen.getByText(/94.1% of asset 42's calls/)).toBeInTheDocument();
  });

  it("shows the corroboration arithmetic behind the score", () => {
    render(<SignalExplainability signal={buildSignal()} />);

    expect(screen.getByText(/3 detectors · weighted mean 0.90 ×1.30/)).toBeInTheDocument();
  });

  it("shows the risk tier", () => {
    render(<SignalExplainability signal={buildSignal()} />);

    expect(screen.getByTestId("risk-tier")).toHaveTextContent("critical");
  });

  it("renders a raw detector signal's own measurements", () => {
    const signal = buildSignal({
      detector: "velocity",
      score: 0.75,
      riskTier: "high",
      explanation: "Usage of asset 42 spiked: 200 calls against a baseline of 5.0 ± 1.0 (z = 195).",
      evidence: {
        summary: "Usage of asset 42 spiked.",
        metrics: { currentCalls: 200, baselineMean: 5, zScore: 195 },
        samples: [{ bucketStart: 1_700_000_000_000, calls: 5 }],
      },
    });

    render(<SignalExplainability signal={signal} />);

    expect(screen.queryAllByTestId("detector-part")).toHaveLength(0);
    expect(screen.getByText("currentCalls")).toBeInTheDocument();
    expect(screen.getByText("195")).toBeInTheDocument();
    expect(screen.getByTestId("evidence-samples")).toBeInTheDocument();
  });

  it("surfaces why a dismissed signal was dismissed", () => {
    const signal = buildSignal({
      status: "dismissed",
      dismissedBy: "moderator@example.com",
      dismissReason: "known integration partner",
    });

    render(<SignalExplainability signal={signal} />);

    expect(screen.getByText(/known integration partner/)).toBeInTheDocument();
    expect(screen.getByText("dismissed")).toBeInTheDocument();
  });

  it("survives an evidence payload with no breakdown at all", () => {
    const signal = buildSignal({ evidence: {}, explanation: "Something fired for a reason." });

    render(<SignalExplainability signal={signal} />);

    expect(screen.getByTestId("signal-explanation")).toHaveTextContent(
      "Something fired for a reason."
    );
    expect(screen.queryAllByTestId("detector-part")).toHaveLength(0);
  });
});
