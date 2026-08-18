import Link from "next/link";

const CATEGORIES = [
  {
    type: "Prompt",
    name: "Prompts",
    icon: "📝",
  },
  {
    type: "Workflow",
    name: "Workflows",
    icon: "⚙️",
  },
  {
    type: "ReasoningChain",
    name: "Reasoning Chains",
    icon: "🧠",
  },
  {
    type: "Dataset",
    name: "Datasets",
    icon: "📊",
  },
  {
    type: "Evaluator",
    name: "Evaluators",
    icon: "✓",
  },
  {
    type: "MemorySystem",
    name: "Memory Systems",
    icon: "💾",
  },
  {
    type: "ModelInstruction",
    name: "Model Instructions",
    icon: "📋",
  },
  {
    type: "Tool",
    name: "Tools",
    icon: "🔧",
  },
];

export default function CategoryNav() {
  return (
    <aside className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Browse by Type
      </h3>
      <nav className="space-y-2">
        {CATEGORIES.map((category) => (
          <Link
            key={category.type}
            href={`/marketplace/category/${category.type}`}
            className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-purple-500/10 hover:text-purple-300"
          >
            <span className="text-lg">{category.icon}</span>
            <span className="font-medium text-zinc-300 group-hover:text-purple-300">
              {category.name}
            </span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
