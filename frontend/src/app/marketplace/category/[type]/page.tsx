import Link from "next/link";
import CategoryContent from "./content";

const ASSET_CATEGORIES = [
  {
    type: "Prompt",
    name: "Prompts",
    description: "Pre-crafted prompt templates and instructions for AI models",
  },
  {
    type: "Workflow",
    name: "Workflows",
    description: "Complex multi-step processes and automation templates",
  },
  {
    type: "ReasoningChain",
    name: "Reasoning Chains",
    description: "Step-by-step reasoning frameworks and logic systems",
  },
  {
    type: "Dataset",
    name: "Datasets",
    description: "Curated data collections for training and evaluation",
  },
  {
    type: "Evaluator",
    name: "Evaluators",
    description: "Testing and validation frameworks for AI outputs",
  },
  {
    type: "MemorySystem",
    name: "Memory Systems",
    description: "Context retention and recall mechanisms for AI",
  },
  {
    type: "ModelInstruction",
    name: "Model Instructions",
    description: "Custom instructions and guidelines for LLM behavior",
  },
  {
    type: "Tool",
    name: "Tools",
    description: "Executable utilities and integrations for workflows",
  },
];

export default function CategoryPage({ params }: { params: { type: string } }) {
  const category = ASSET_CATEGORIES.find((cat) => cat.type === params.type);

  if (!category) {
    return (
      <main className="min-h-screen bg-black px-6 py-12 text-white">
        <div className="mx-auto max-w-5xl">
          <div className="rounded-xl border border-red-900/70 bg-red-950/30 px-6 py-12 text-center">
            <h1 className="text-2xl font-bold text-red-300">Category not found</h1>
            <p className="mt-2 text-red-200/70">This asset category does not exist.</p>
            <Link href="/marketplace" className="mt-6 inline-block text-sm font-semibold text-purple-400 hover:text-purple-300">
              ← Back to Marketplace
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black px-6 py-12 text-white">
      <div className="mx-auto max-w-7xl">
        {/* Breadcrumb */}
        <Link href="/marketplace" className="mb-8 inline-block text-sm text-zinc-400 hover:text-white">
          ← Marketplace
        </Link>

        {/* Header */}
        <header className="mb-12 border-b border-zinc-800 pb-8">
          <div className="mb-4 inline-block rounded-full bg-purple-500/15 px-3 py-1 text-sm font-semibold text-purple-300">
            Asset Category
          </div>
          <h1 className="text-4xl font-bold tracking-tight">{category.name}</h1>
          <p className="mt-3 max-w-3xl text-lg text-zinc-400">{category.description}</p>
        </header>

        {/* Content */}
        <CategoryContent type={params.type} categoryName={category.name} />
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return ASSET_CATEGORIES.map((category) => ({
    type: category.type,
  }));
}

export const revalidate = 3600; // Revalidate every hour (ISR)
