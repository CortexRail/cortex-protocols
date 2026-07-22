"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AssetCard from "@/components/marketplace/AssetCard";

interface Asset {
  id: string;
  name: string;
  type: string;
  price: number;
  description: string;
  version: number;
  isActive: boolean;
}

const placeholderAssets: Asset[] = [
  {
    id: "1",
    name: "Sentiment Analysis Engine",
    type: "Model",
    price: 5000000,
    description: "Advanced NLP model for real-time sentiment analysis across multiple languages and domains.",
    version: 2,
    isActive: true,
  },
  {
    id: "2",
    name: "Data Extraction Pipeline",
    type: "Workflow",
    price: 3500000,
    description: "Automated pipeline for extracting structured data from unstructured documents and web sources.",
    version: 1,
    isActive: true,
  },
  {
    id: "3",
    name: "Threat Detection System",
    type: "Tool",
    price: 7500000,
    description: "Real-time threat detection and classification system for cybersecurity applications.",
    version: 3,
    isActive: true,
  },
  {
    id: "4",
    name: "Knowledge Graph Builder",
    type: "Tool",
    price: 4200000,
    description: "Construct and maintain knowledge graphs from heterogeneous data sources with entity linking.",
    version: 1,
    isActive: true,
  },
  {
    id: "5",
    name: "Forecasting Model",
    type: "Model",
    price: 6000000,
    description: "Time-series forecasting model for predicting trends and anomalies in financial and operational data.",
    version: 2,
    isActive: false,
  },
  {
    id: "6",
    name: "Document Summarizer",
    type: "Model",
    price: 2800000,
    description: "AI-powered document summarization with customizable length and focus areas.",
    version: 1,
    isActive: true,
  },
  {
    id: "7",
    name: "Anomaly Detector",
    type: "Tool",
    price: 4500000,
    description: "Statistical and ML-based anomaly detection for monitoring system behavior and data quality.",
    version: 2,
    isActive: true,
  },
  {
    id: "8",
    name: "Classification Framework",
    type: "Workflow",
    price: 3900000,
    description: "End-to-end classification workflow with feature engineering and model selection automation.",
    version: 1,
    isActive: true,
  },
];

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate loading delay
    const timer = setTimeout(() => {
      setAssets(placeholderAssets);
      setLoading(false);
    }, 800);

    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="min-h-screen bg-black px-6 py-12 text-white">
      <div className="mx-auto max-w-7xl">
        <header className="mb-10 flex flex-col gap-4 border-b border-zinc-800 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link href="/" className="mb-4 inline-block text-sm text-zinc-400 hover:text-white">
              ← Intelligence Rail
            </Link>
            <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-purple-400">
              Intelligence assets
            </p>
            <h1 className="text-4xl font-bold tracking-tight">Assets</h1>
            <p className="mt-2 max-w-2xl text-zinc-400">
              Browse available intelligence assets including models, workflows, and tools.
            </p>
          </div>
        </header>

        {loading ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-16 text-center text-zinc-400">
            Loading assets…
          </div>
        ) : assets.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-16 text-center">
            <p className="font-semibold">No assets available</p>
            <p className="mt-2 text-sm text-zinc-500">Check back later for new intelligence assets.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                id={asset.id}
                name={asset.name}
                type={asset.type}
                price={asset.price}
                description={asset.description}
                version={asset.version}
                isActive={asset.isActive}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
