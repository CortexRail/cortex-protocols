#!/usr/bin/env node

/**
 * Benchmark script for advanced search performance.
 * Tests search performance with varying dataset sizes and query types.
 *
 * Usage:
 *   node src/scripts/benchmarkSearch.js [datasetSize]
 *
 * Example:
 *   node src/scripts/benchmarkSearch.js 10000
 */

const { generateSyntheticAssets, advancedSearch } = require("../utils/advancedSearch");
const { logger } = require("../utils/logger");

// Test queries with different characteristics
const TEST_QUERIES = [
  "machine learning dataset", // Multi-word, common terms
  "transformr", // Typo (should match "transformer")
  "nlp", // Short acronym
  "advanced neural network tool", // Long query
  "python", // Single word, likely high frequency
  "optimized classification", // Two-word technical query
  "xyz123", // Nonsense query (no matches)
  "deep learning", // Common phrase
];

/**
 * Format duration in human-readable format
 */
function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format throughput in human-readable format
 */
function formatThroughput(perSecond) {
  if (perSecond > 1000000)
    return `${(perSecond / 1000000).toFixed(2)}M items/s`;
  if (perSecond > 1000) return `${(perSecond / 1000).toFixed(2)}K items/s`;
  return `${perSecond.toFixed(0)} items/s`;
}

/**
 * Run comprehensive benchmark suite
 */
function runBenchmarkSuite(datasetSize = 10000) {
  logger.info("=".repeat(80));
  logger.info("ADVANCED SEARCH PERFORMANCE BENCHMARK");
  logger.info("=".repeat(80));
  logger.info();

  logger.info(`Dataset Size: ${datasetSize.toLocaleString()} assets`);
  logger.info(`Test Queries: ${TEST_QUERIES.length}`);
  logger.info();

  // Generate dataset once for all tests
  logger.info("Generating synthetic dataset...");
  const startGen = Date.now();
  const assets = generateSyntheticAssets(datasetSize);
  const genDuration = Date.now() - startGen;
  logger.info(`✓ Dataset generated in ${formatDuration(genDuration)}`);
  logger.info();

  // Run benchmarks for each query
  const results = [];

  logger.info("-".repeat(80));
  logger.info("Query Benchmarks:");
  logger.info("-".repeat(80));

  for (const query of TEST_QUERIES) {
    const startTime = Date.now();
    const searchResults = advancedSearch(assets, query);
    const endTime = Date.now();

    const duration = endTime - startTime;
    const throughput = datasetSize / (duration / 1000);

    const result = {
      query,
      resultsCount: searchResults.length,
      durationMs: duration,
      throughput,
      topScore: searchResults.length > 0 ? searchResults[0].score : 0,
      avgScore:
        searchResults.length > 0
          ? searchResults.reduce((sum, r) => sum + r.score, 0) /
            searchResults.length
          : 0,
    };

    results.push(result);

    logger.info(`Query: "${query}"`);
    logger.info(`  Results: ${result.resultsCount.toLocaleString()}`);
    logger.info(`  Duration: ${formatDuration(duration)}`);
    logger.info(`  Throughput: ${formatThroughput(throughput)}`);
    logger.info(`  Top Score: ${result.topScore.toFixed(2)}`);
    logger.info(`  Avg Score: ${result.avgScore.toFixed(2)}`);
    logger.info();
  }

  // Calculate aggregate statistics
  logger.info("=".repeat(80));
  logger.info("AGGREGATE STATISTICS");
  logger.info("=".repeat(80));
  logger.info();

  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const avgDuration = totalDuration / results.length;
  const minDuration = Math.min(...results.map((r) => r.durationMs));
  const maxDuration = Math.max(...results.map((r) => r.durationMs));
  const avgThroughput =
    results.reduce((sum, r) => sum + r.throughput, 0) / results.length;

  logger.info(`Total Test Duration: ${formatDuration(totalDuration)}`);
  logger.info(`Average Query Time: ${formatDuration(avgDuration)}`);
  logger.info(`Min Query Time: ${formatDuration(minDuration)}`);
  logger.info(`Max Query Time: ${formatDuration(maxDuration)}`);
  logger.info(`Average Throughput: ${formatThroughput(avgThroughput)}`);
  logger.info();

  // Performance targets and analysis
  logger.info("-".repeat(80));
  logger.info("Performance Analysis:");
  logger.info("-".repeat(80));
  logger.info();

  const targetDuration = 100; // 100ms target for good UX
  const fastQueries = results.filter(
    (r) => r.durationMs < targetDuration,
  ).length;
  const slowQueries = results.filter(
    (r) => r.durationMs >= targetDuration,
  ).length;

  logger.info(
    `Queries under ${targetDuration}ms target: ${fastQueries}/${results.length}`,
  );
  logger.info(
    `Queries over ${targetDuration}ms target: ${slowQueries}/${results.length}`,
  );
  logger.info();

  if (avgDuration < targetDuration) {
    logger.info("✓ PASS: Average query time meets performance target");
  } else {
    logger.info(
      `✗ FAIL: Average query time (${formatDuration(avgDuration)}) exceeds target (${targetDuration}ms)`,
    );
  }
  logger.info();

  // Memory usage estimate
  const estimatedMemoryPerAsset = 1000; // bytes (rough estimate)
  const estimatedMemoryMB =
    (datasetSize * estimatedMemoryPerAsset) / (1024 * 1024);
  logger.info(`Estimated Memory Usage: ~${estimatedMemoryMB.toFixed(2)}MB`);
  logger.info();

  return results;
}

/**
 * Run scalability test with increasing dataset sizes
 */
function runScalabilityTest() {
  logger.info("=".repeat(80));
  logger.info("SCALABILITY TEST");
  logger.info("=".repeat(80));
  logger.info();

  const sizes = [100, 500, 1000, 5000, 10000];
  const testQuery = "machine learning dataset";

  logger.info(`Test Query: "${testQuery}"`);
  logger.info();

  const scalabilityResults = [];

  for (const size of sizes) {
    logger.info(`Testing with ${size.toLocaleString()} assets...`);

    const assets = generateSyntheticAssets(size);
    const startTime = Date.now();
    const results = advancedSearch(assets, testQuery);
    const duration = Date.now() - startTime;
    const throughput = size / (duration / 1000);

    scalabilityResults.push({
      size,
      duration,
      throughput,
      resultsCount: results.length,
    });

    logger.info(`  Duration: ${formatDuration(duration)}`);
    logger.info(`  Throughput: ${formatThroughput(throughput)}`);
    logger.info();
  }

  // Analyze scaling behavior
  logger.info("-".repeat(80));
  logger.info("Scaling Analysis:");
  logger.info("-".repeat(80));
  logger.info();

  for (let i = 1; i < scalabilityResults.length; i++) {
    const prev = scalabilityResults[i - 1];
    const curr = scalabilityResults[i];
    const sizeRatio = curr.size / prev.size;
    const durationRatio = curr.duration / prev.duration;
    const complexity = Math.log(durationRatio) / Math.log(sizeRatio);

    logger.info(
      `${prev.size} → ${curr.size} (${sizeRatio.toFixed(1)}x size increase):`,
    );
    logger.info(`  Duration increased by ${durationRatio.toFixed(2)}x`);
    logger.info(`  Estimated complexity: O(n^${complexity.toFixed(2)})`);
    logger.info();
  }

  return scalabilityResults;
}

/**
 * Run fuzzy matching validation test
 */
function runFuzzyMatchingTest() {
  logger.info("=".repeat(80));
  logger.info("FUZZY MATCHING VALIDATION");
  logger.info("=".repeat(80));
  logger.info();

  const assets = [
    {
      id: "1",
      name: "Transformer Neural Network",
      description: "Advanced transformer-based model",
      tags: ["deep-learning", "nlp"],
      createdAt: Date.now(),
    },
    {
      id: "2",
      name: "Dataset Processing Tool",
      description: "Tool for processing large datasets",
      tags: ["data", "processing"],
      createdAt: Date.now(),
    },
    {
      id: "3",
      name: "Machine Learning Workflow",
      description: "End-to-end ML workflow automation",
      tags: ["ml", "workflow", "automation"],
      createdAt: Date.now(),
    },
  ];

  const typoTests = [
    { query: "transformr", expected: "Transformer Neural Network" },
    { query: "machne learning", expected: "Machine Learning Workflow" },
    { query: "proccessing", expected: "Dataset Processing Tool" },
    { query: "workflo", expected: "Machine Learning Workflow" },
  ];

  logger.info("Testing typo tolerance (Levenshtein distance ≤ 2):");
  logger.info();

  let passCount = 0;

  for (const test of typoTests) {
    const results = advancedSearch(assets, test.query);
    const topResult = results.length > 0 ? results[0].name : null;
    const passed = topResult === test.expected;

    logger.info(`Query: "${test.query}"`);
    logger.info(`  Expected: "${test.expected}"`);
    logger.info(`  Got: "${topResult || "no results"}"`);
    logger.info(`  Status: ${passed ? "✓ PASS" : "✗ FAIL"}`);
    if (results.length > 0) {
      logger.info(`  Score: ${results[0].score.toFixed(2)}`);
    }
    logger.info();

    if (passed) passCount++;
  }

  logger.info(`Fuzzy Matching Tests: ${passCount}/${typoTests.length} passed`);
  logger.info();
}

/**
 * Run exact match boost validation
 */
function runExactMatchTest() {
  logger.info("=".repeat(80));
  logger.info("EXACT MATCH BOOST VALIDATION");
  logger.info("=".repeat(80));
  logger.info();

  const assets = [
    {
      id: "1",
      name: "dataset",
      description:
        "A comprehensive dataset for machine learning with various features",
      tags: ["data"],
      createdAt: Date.now(),
    },
    {
      id: "2",
      name: "Machine Learning Tool",
      description: "This tool includes a dataset module and various utilities",
      tags: ["ml", "tool"],
      createdAt: Date.now(),
    },
    {
      id: "3",
      name: "Dataset Analysis Framework",
      description: "Framework for analyzing datasets",
      tags: ["dataset", "analysis"],
      createdAt: Date.now(),
    },
  ];

  const query = "dataset";
  const results = advancedSearch(assets, query);

  logger.info(`Query: "${query}"`);
  logger.info();
  logger.info("Results (should show exact name match first with 3x boost):");
  logger.info();

  results.forEach((result, index) => {
    logger.info(
      `${index + 1}. "${result.name}" - Score: ${result.score.toFixed(2)}`,
    );
  });
  logger.info();

  const topResult = results[0];
  const hasExactMatch =
    topResult && topResult.name.toLowerCase() === query.toLowerCase();

  if (hasExactMatch) {
    logger.info("✓ PASS: Exact match boosted to top position");
  } else {
    logger.info("✗ FAIL: Exact match not at top position");
  }
  logger.info();
}

// Main execution
if (require.main === module) {
  const datasetSize = parseInt(process.argv[2]) || 10000;

  logger.info();
  runBenchmarkSuite(datasetSize);

  logger.info();
  runScalabilityTest();

  logger.info();
  runFuzzyMatchingTest();

  logger.info();
  runExactMatchTest();

  logger.info("=".repeat(80));
  logger.info("BENCHMARK COMPLETE");
  logger.info("=".repeat(80));
  logger.info();
}

module.exports = {
  runBenchmarkSuite,
  runScalabilityTest,
  runFuzzyMatchingTest,
  runExactMatchTest,
};
