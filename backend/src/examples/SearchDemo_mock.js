#!/usr/bin/env node

/**
 * Interactive demo of the advanced search functionality.
 * Shows TF-IDF scoring, fuzzy matching, and exact match boosting in action.
 */

const { advancedSearch } = require("../utils/advancedSearch");
const { logger } = require("../utils/logger");

// Sample dataset mimicking real assets
const sampleAssets = [
  {
    id: "asset-1",
    name: "GPT-4 Prompt Template",
    description:
      "Professional prompt template for GPT-4 with advanced reasoning chains. Optimized for complex tasks.",
    assetType: "Prompt",
    licenseType: "OpenSource",
    tags: ["gpt4", "prompt", "reasoning", "openai"],
    price: 0,
    usageCount: 1250,
    createdAt: Date.now() - 86400000 * 30,
  },
  {
    id: "asset-2",
    name: "Machine Learning Dataset",
    description:
      "Comprehensive dataset for training machine learning models. Includes 100K labeled examples.",
    assetType: "Dataset",
    licenseType: "UsageBased",
    tags: ["ml", "dataset", "training", "classification"],
    price: 50,
    usageCount: 3420,
    createdAt: Date.now() - 86400000 * 15,
  },
  {
    id: "asset-3",
    name: "Transformer Neural Network",
    description:
      "State-of-the-art transformer architecture for NLP tasks. Pre-trained on large corpus.",
    assetType: "ModelInstruction",
    licenseType: "Subscription",
    tags: ["transformer", "nlp", "deep-learning", "neural-network"],
    price: 100,
    usageCount: 890,
    createdAt: Date.now() - 86400000 * 5,
  },
  {
    id: "asset-4",
    name: "Dataset Processing Workflow",
    description:
      "Automated workflow for cleaning and processing raw datasets. Includes validation and transformation steps.",
    assetType: "Workflow",
    licenseType: "Perpetual",
    tags: ["workflow", "data-processing", "etl", "automation"],
    price: 75,
    usageCount: 445,
    createdAt: Date.now() - 86400000 * 20,
  },
  {
    id: "asset-5",
    name: "Reasoning Chain Evaluator",
    description:
      "Tool for evaluating the quality of AI reasoning chains. Provides detailed metrics and feedback.",
    assetType: "Evaluator",
    licenseType: "OpenSource",
    tags: ["evaluator", "reasoning", "quality", "metrics"],
    price: 0,
    usageCount: 678,
    createdAt: Date.now() - 86400000 * 10,
  },
  {
    id: "asset-6",
    name: "Neural Network Training Tool",
    description:
      "Comprehensive tool for training neural networks with hyperparameter optimization.",
    assetType: "Tool",
    licenseType: "UsageBased",
    tags: ["neural-network", "training", "optimization", "tool"],
    price: 120,
    usageCount: 2100,
    createdAt: Date.now() - 86400000 * 7,
  },
  {
    id: "asset-7",
    name: "Dataset",
    description: "General purpose dataset for various machine learning tasks.",
    assetType: "Dataset",
    licenseType: "OpenSource",
    tags: ["dataset", "general"],
    price: 0,
    usageCount: 5600,
    createdAt: Date.now() - 86400000 * 60,
  },
  {
    id: "asset-8",
    name: "Deep Learning Memory System",
    description:
      "Advanced memory system for deep learning models. Enables long-context understanding.",
    assetType: "MemorySystem",
    licenseType: "Subscription",
    tags: ["memory", "deep-learning", "context", "ai"],
    price: 150,
    usageCount: 320,
    createdAt: Date.now() - 86400000 * 3,
  },
  {
    id: "asset-9",
    name: "NLP Preprocessing Workflow",
    description:
      "Complete workflow for preprocessing natural language data. Includes tokenization, cleaning, and normalization.",
    assetType: "Workflow",
    licenseType: "Perpetual",
    tags: ["nlp", "preprocessing", "workflow", "text"],
    price: 60,
    usageCount: 1150,
    createdAt: Date.now() - 86400000 * 25,
  },
  {
    id: "asset-10",
    name: "Model Instruction Set",
    description:
      "Curated instruction set for fine-tuning language models. Covers various task types.",
    assetType: "ModelInstruction",
    licenseType: "UsageBased",
    tags: ["instructions", "fine-tuning", "llm", "training"],
    price: 80,
    usageCount: 980,
    createdAt: Date.now() - 86400000 * 12,
  },
];

/**
 * Print search results in a formatted table
 */
function printResults(query, results, maxResults = 10) {
  logger.info("\n" + "=".repeat(100));
  logger.info(`SEARCH QUERY: "${query}"`);
  logger.info("=".repeat(100));
  logger.info();

  if (results.length === 0) {
    logger.info("No results found.");
    return;
  }

  logger.info(`Found ${results.length} result(s):\n`);

  results.slice(0, maxResults).forEach((asset, index) => {
    const scoreBar =
      "█".repeat(Math.round(asset.score / 5)) +
      "░".repeat(20 - Math.round(asset.score / 5));
    const priceDisplay = asset.price === 0 ? "FREE" : `$${asset.price}`;

    logger.info(`${index + 1}. [Score: ${asset.score.toFixed(2)} ${scoreBar}]`);
    logger.info(`   ${asset.name}`);
    logger.info(
      `   Type: ${asset.assetType} | License: ${asset.licenseType} | Price: ${priceDisplay}`,
    );
    logger.info(`   Tags: ${asset.tags.join(", ")}`);
    logger.info(`   ${asset.description.substring(0, 80)}...`);
    logger.info();
  });
}

/**
 * Run demo searches with various query types
 */
function runDemo() {
  logger.info("\n");
  logger.info(
    "╔════════════════════════════════════════════════════════════════════════════════╗",
  );
  logger.info(
    "║                   ADVANCED SEARCH DEMONSTRATION                                ║",
  );
  logger.info(
    "║                                                                                ║",
  );
  logger.info(
    "║  Features:                                                                     ║",
  );
  logger.info(
    "║  ✓ TF-IDF Scoring across name, description, and tags                          ║",
  );
  logger.info(
    "║  ✓ 3x Boost for exact name matches                                            ║",
  );
  logger.info(
    "║  ✓ Fuzzy matching with Levenshtein distance ≤ 2                               ║",
  );
  logger.info(
    "║  ✓ Configurable field weights (name: 3, tags: 2, description: 1)              ║",
  );
  logger.info(
    "╚════════════════════════════════════════════════════════════════════════════════╝",
  );

  // Demo 1: Basic multi-word search
  logger.info("\n\n📌 DEMO 1: Multi-word search");
  logger.info("Shows how TF-IDF scoring ranks relevant results");
  const results1 = advancedSearch(sampleAssets, "machine learning dataset");
  printResults("machine learning dataset", results1, 5);

  // Demo 2: Exact match boost
  logger.info("\n\n📌 DEMO 2: Exact match boost (3x multiplier)");
  logger.info(
    'Notice how "Dataset" with exact name match gets top score despite less descriptive content',
  );
  const results2 = advancedSearch(sampleAssets, "dataset");
  printResults("dataset", results2, 5);

  // Demo 3: Fuzzy matching with typo
  logger.info("\n\n📌 DEMO 3: Fuzzy matching (typo tolerance)");
  logger.info(
    'Query has typo: "transformr" → should still match "transformer"',
  );
  const results3 = advancedSearch(sampleAssets, "transformr neural network");
  printResults("transformr neural network", results3, 5);

  // Demo 4: Tag-based search
  logger.info("\n\n📌 DEMO 4: Tag-based search");
  logger.info("Tags have 2x weight, so tag matches score higher");
  const results4 = advancedSearch(sampleAssets, "nlp");
  printResults("nlp", results4, 5);

  // Demo 5: Complex query
  logger.info("\n\n📌 DEMO 5: Complex query with multiple terms");
  logger.info("Shows how multiple terms combine in scoring");
  const results5 = advancedSearch(
    sampleAssets,
    "neural network training optimization",
  );
  printResults("neural network training optimization", results5, 5);

  // Demo 6: Low relevance filter
  logger.info("\n\n📌 DEMO 6: Filtering low-relevance results");
  logger.info("Using minScore: 10 to filter out weak matches");
  const results6 = advancedSearch(sampleAssets, "workflow", { minScore: 10 });
  printResults("workflow (minScore: 10)", results6, 5);

  // Demo 7: Custom field weights
  logger.info("\n\n📌 DEMO 7: Custom field weights");
  logger.info("Boosting description weight to prioritize detailed content");
  const results7 = advancedSearch(sampleAssets, "training", {
    weights: { name: 2, description: 3, tags: 1 },
  });
  printResults("training (custom weights)", results7, 5);

  // Demo 8: Another typo example
  logger.info("\n\n📌 DEMO 8: More fuzzy matching examples");
  logger.info('Query: "datset proccessing" (multiple typos)');
  const results8 = advancedSearch(sampleAssets, "datset proccessing");
  printResults("datset proccessing", results8, 5);

  // Summary
  logger.info("\n" + "=".repeat(100));
  logger.info("DEMO COMPLETE");
  logger.info("=".repeat(100));
  logger.info("\nKey Observations:");
  logger.info("• Exact matches receive significant boost (3x)");
  logger.info("• Fuzzy matching handles common typos (≤2 character edits)");
  logger.info("• TF-IDF scoring provides relevance-based ranking");
  logger.info(
    "• Field weights allow customization (name > tags > description)",
  );
  logger.info(
    "• Score field (0-100) enables client-side sorting and filtering",
  );
  logger.info();
  logger.info("Run benchmarks with: node src/scripts/benchmarkSearch.js 10000");
  logger.info("See documentation: docs/ADVANCED_SEARCH.md");
  logger.info();
}

// Run demo if executed directly
if (require.main === module) {
  runDemo();
}

module.exports = { runDemo, sampleAssets };
