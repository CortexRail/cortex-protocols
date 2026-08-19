/**
 * The report is opened straight off disk from a CI artifact, so these tests
 * hold it to being valid, self-contained HTML that renders with no network.
 */

const { generateReport, escapeHtml, formatNumber } = require("../../simulation/report-generator");

function sampleRun(overrides = {}) {
  return {
    config: { agentCount: 2, durationMs: 1000, seed: 1 },
    metrics: {
      durationMs: 60_000,
      totalSamples: 120,
      totalErrors: 3,
      errorRate: 0.025,
      throughputPerSec: 2,
      operations: {
        handshake: { count: 10, errors: 0, min: 1, p50: 3, p95: 8, p99: 9, max: 10, mean: 4 },
        meteredCall: { count: 100, errors: 3, min: 1, p50: 12, p95: 40, p99: 90, max: 120, mean: 18 },
      },
      errorBreakdown: [{ label: "timeout", count: 3 }],
    },
    totals: { agents: 2, streamsOpened: 2, streamsSettled: 2 },
    reconciliation: {
      ok: true,
      checks: [{ name: "every opened stream was settled", ok: true, detail: "2 of 2" }],
    },
    agents: [
      {
        id: "agent-000",
        strategy: "GreedyBuyer",
        state: "done",
        ledger: { streamsOpened: 1, callsSucceeded: 50, callsDropped: 0, errors: [] },
      },
    ],
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("neutralises markup in interpolated values", () => {
    expect(escapeHtml('<script>"x"&y</script>')).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;y&lt;/script&gt;"
    );
  });

  it("renders null and undefined as empty strings", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("formatNumber", () => {
  it("groups thousands and rounds to two decimals", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(1.23456)).toBe("1.23");
  });

  it("renders non-finite values as 0", () => {
    expect(formatNumber(NaN)).toBe("0");
    expect(formatNumber(Infinity)).toBe("0");
  });
});

describe("generateReport", () => {
  const html = generateReport(sampleRun(), { generatedAt: "2026-08-18T00:00:00Z" });

  it("produces a complete HTML document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<html lang=\"en\">");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<title>");
  });

  it("has balanced html, head and body tags", () => {
    for (const tag of ["html", "head", "body"]) {
      expect((html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length).toBe(1);
      expect((html.match(new RegExp(`</${tag}>`, "g")) ?? []).length).toBe(1);
    }
  });

  it("is fully self-contained — no external requests of any kind", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
  });

  it("draws its charts as inline SVG rather than a chart library", () => {
    expect(html).toContain("<svg");
    expect(html).toContain("</svg>");
    expect(html).toContain("<rect");
  });

  it("reports the headline numbers", () => {
    expect(html).toContain("2.5%"); // error rate
    expect(html).toContain("Metered call");
    expect(html).toContain("Handshake");
  });

  it("renders the reconciliation checklist", () => {
    expect(html).toContain("State reconciliation");
    expect(html).toContain("every opened stream was settled");
    expect(html).toContain(">PASS<");
  });

  it("flags a run whose reconciliation failed", () => {
    const failed = generateReport(
      sampleRun({
        reconciliation: {
          ok: false,
          checks: [{ name: "every opened stream was settled", ok: false, detail: "1 of 2" }],
        },
      })
    );
    expect(failed).toContain("NEEDS ATTENTION");
    expect(failed).toContain(">FAIL<");
  });

  it("flags a run whose error rate blew the budget", () => {
    const noisy = generateReport(sampleRun({ metrics: { ...sampleRun().metrics, errorRate: 0.4 } }));
    expect(noisy).toContain("NEEDS ATTENTION");
  });

  it("escapes agent-supplied strings instead of interpolating markup", () => {
    const hostile = generateReport(
      sampleRun({
        agents: [
          {
            id: "<img src=x onerror=alert(1)>",
            strategy: "GreedyBuyer",
            state: "done",
            ledger: { streamsOpened: 0, callsSucceeded: 0, callsDropped: 0, errors: [] },
          },
        ],
      })
    );
    expect(hostile).not.toMatch(/<img\b/i);
    expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders an empty run without throwing", () => {
    const empty = generateReport({});
    expect(empty).toContain("<!DOCTYPE html>");
    expect(empty).toContain("No errors recorded.");
  });

  it("includes the chaos section when faults were injected", () => {
    const withChaos = generateReport(sampleRun(), {
      chaos: {
        enabled: true,
        faults: ["backend-restart"],
        injected: 1,
        history: [{ type: "backend-restart", at: 0, ok: true }],
      },
    });
    expect(withChaos).toContain("Chaos");
    expect(withChaos).toContain("backend-restart");
  });
});
