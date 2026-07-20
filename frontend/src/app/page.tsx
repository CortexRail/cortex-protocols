import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
      <div className="max-w-3xl w-full text-center space-y-8">
        {/* Header */}
        <div className="space-y-3">
          <p className="text-sm font-mono text-purple-400 tracking-widest uppercase">
            Cortex Protocol
          </p>
          <h1 className="text-5xl font-bold tracking-tight">
            Intelligence Rail
          </h1>
          <p className="text-lg text-zinc-400 max-w-xl mx-auto">
            Open infrastructure for autonomous agents to discover, exchange, and
            evolve intelligence assets through programmable micropayments.
          </p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 py-6 border-y border-zinc-800">
          {[
            { label: "Asset Types", value: "8" },
            { label: "License Models", value: "4" },
            { label: "Built on", value: "Stellar" },
          ].map(({ label, value }) => (
            <div key={label} className="space-y-1">
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
            </div>
          ))}
        </div>

        {/* Feature list */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
          {[
            "Prompts & Reasoning Chains",
            "Agent Workflows",
            "Soroban Micropayments",
            "Usage-Based Licensing",
            "Agent Identity & Reputation",
            "AI-to-AI Commerce",
          ].map((feature) => (
            <div
              key={feature}
              className="flex items-center gap-2 text-sm text-zinc-300"
            >
              <span className="text-purple-400">▸</span>
              {feature}
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
          <a
            href="https://github.com/CortexRail/cortex-protocols"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 bg-white text-black font-semibold rounded-lg hover:bg-zinc-200 transition-colors"
          >
            View on GitHub
          </a>
          <Link
            href="/marketplace"
            className="px-6 py-3 border border-zinc-700 text-white font-semibold rounded-lg hover:border-zinc-500 transition-colors"
          >
            Explore Marketplace
          </Link>
        </div>
      </div>
    </main>
  );
}
