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

const {
  benchmarkSearch,
  generateSyntheticAssets,
  advancedSearch,
} = require("../utils/advancedSearch");

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
  console.log("=".repeat(80));
  console.log("ADVANCED SEARCH PERFORMANCE BENCHMARK");
  console.log("=".repeat(80));
  console.log();

  console.log(`Dataset Size: ${datasetSize.toLocaleString()} assets`);
  console.log(`Test Queries: ${TEST_QUERIES.length}`);
  console.log();

  // Generate dataset once for all tests
  console.log("Generating synthetic dataset...");
  const startGen = Date.now();
  const assets = generateSyntheticAssets(datasetSize);
  const genDuration = Date.now() - startGen;
  console.log(`✓ Dataset generated in ${formatDuration(genDuration)}`);
  console.log();

  // Run benchmarks for each query
  const results = [];

  console.log("-".repeat(80));
  console.log("Query Benchmarks:");
  console.log("-".repeat(80));

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

    console.log(`Query: "${query}"`);
    console.log(`  Results: ${result.resultsCount.toLocaleString()}`);
    console.log(`  Duration: ${formatDuration(duration)}`);
    console.log(`  Throughput: ${formatThroughput(throughput)}`);
    console.log(`  Top Score: ${result.topScore.toFixed(2)}`);
    console.log(`  Avg Score: ${result.avgScore.toFixed(2)}`);
    console.log();
  }

  // Calculate aggregate statistics
  console.log("=".repeat(80));
  console.log("AGGREGATE STATISTICS");
  console.log("=".repeat(80));
  console.log();

  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const avgDuration = totalDuration / results.length;
  const minDuration = Math.min(...results.map((r) => r.durationMs));
  const maxDuration = Math.max(...results.map((r) => r.durationMs));
  const avgThroughput =
    results.reduce((sum, r) => sum + r.throughput, 0) / results.length;

  console.log(`Total Test Duration: ${formatDuration(totalDuration)}`);
  console.log(`Average Query Time: ${formatDuration(avgDuration)}`);
  console.log(`Min Query Time: ${formatDuration(minDuration)}`);
  console.log(`Max Query Time: ${formatDuration(maxDuration)}`);
  console.log(`Average Throughput: ${formatThroughput(avgThroughput)}`);
  console.log();

  // Performance targets and analysis
  console.log("-".repeat(80));
  console.log("Performance Analysis:");
  console.log("-".repeat(80));
  console.log();

  const targetDuration = 100; // 100ms target for good UX
  const fastQueries = results.filter(
    (r) => r.durationMs < targetDuration,
  ).length;
  const slowQueries = results.filter(
    (r) => r.durationMs >= targetDuration,
  ).length;

  console.log(
    `Queries under ${targetDuration}ms target: ${fastQueries}/${results.length}`,
  );
  console.log(
    `Queries over ${targetDuration}ms target: ${slowQueries}/${results.length}`,
  );
  console.log();

  if (avgDuration < targetDuration) {
    console.log("✓ PASS: Average query time meets performance target");
  } else {
    console.log(
      `✗ FAIL: Average query time (${formatDuration(avgDuration)}) exceeds target (${targetDuration}ms)`,
    );
  }
  console.log();

  // Memory usage estimate
  const estimatedMemoryPerAsset = 1000; // bytes (rough estimate)
  const estimatedMemoryMB =
    (datasetSize * estimatedMemoryPerAsset) / (1024 * 1024);
  console.log(`Estimated Memory Usage: ~${estimatedMemoryMB.toFixed(2)}MB`);
  console.log();

  return results;
}

/**
 * Run scalability test with increasing dataset sizes
 */
function runScalabilityTest() {
  console.log("=".repeat(80));
  console.log("SCALABILITY TEST");
  console.log("=".repeat(80));
  console.log();

  const sizes = [100, 500, 1000, 5000, 10000];
  const testQuery = "machine learning dataset";

  console.log(`Test Query: "${testQuery}"`);
  console.log();

  const scalabilityResults = [];

  for (const size of sizes) {
    console.log(`Testing with ${size.toLocaleString()} assets...`);

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

    console.log(`  Duration: ${formatDuration(duration)}`);
    console.log(`  Throughput: ${formatThroughput(throughput)}`);
    console.log();
  }

  // Analyze scaling behavior
  console.log("-".repeat(80));
  console.log("Scaling Analysis:");
  console.log("-".repeat(80));
  console.log();

  for (let i = 1; i < scalabilityResults.length; i++) {
    const prev = scalabilityResults[i - 1];
    const curr = scalabilityResults[i];
    const sizeRatio = curr.size / prev.size;
    const durationRatio = curr.duration / prev.duration;
    const complexity = Math.log(durationRatio) / Math.log(sizeRatio);

    console.log(
      `${prev.size} → ${curr.size} (${sizeRatio.toFixed(1)}x size increase):`,
    );
    console.log(`  Duration increased by ${durationRatio.toFixed(2)}x`);
    console.log(`  Estimated complexity: O(n^${complexity.toFixed(2)})`);
    console.log();
  }

  return scalabilityResults;
}

/**
 * Run fuzzy matching validation test
 */
function runFuzzyMatchingTest() {
  console.log("=".repeat(80));
  console.log("FUZZY MATCHING VALIDATION");
  console.log("=".repeat(80));
  console.log();

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

  console.log("Testing typo tolerance (Levenshtein distance ≤ 2):");
  console.log();

  let passCount = 0;

  for (const test of typoTests) {
    const results = advancedSearch(assets, test.query);
    const topResult = results.length > 0 ? results[0].name : null;
    const passed = topResult === test.expected;

    console.log(`Query: "${test.query}"`);
    console.log(`  Expected: "${test.expected}"`);
    console.log(`  Got: "${topResult || "no results"}"`);
    console.log(`  Status: ${passed ? "✓ PASS" : "✗ FAIL"}`);
    if (results.length > 0) {
      console.log(`  Score: ${results[0].score.toFixed(2)}`);
    }
    console.log();

    if (passed) passCount++;
  }

  console.log(`Fuzzy Matching Tests: ${passCount}/${typoTests.length} passed`);
  console.log();
}

/**
 * Run exact match boost validation
 */
function runExactMatchTest() {
  console.log("=".repeat(80));
  console.log("EXACT MATCH BOOST VALIDATION");
  console.log("=".repeat(80));
  console.log();

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

  console.log(`Query: "${query}"`);
  console.log();
  console.log("Results (should show exact name match first with 3x boost):");
  console.log();

  results.forEach((result, index) => {
    console.log(
      `${index + 1}. "${result.name}" - Score: ${result.score.toFixed(2)}`,
    );
  });
  console.log();

  const topResult = results[0];
  const hasExactMatch =
    topResult && topResult.name.toLowerCase() === query.toLowerCase();

  if (hasExactMatch) {
    console.log("✓ PASS: Exact match boosted to top position");
  } else {
    console.log("✗ FAIL: Exact match not at top position");
  }
  console.log();
}

// Main execution
if (require.main === module) {
  const datasetSize = parseInt(process.argv[2]) || 10000;

  console.log();
  runBenchmarkSuite(datasetSize);

  console.log();
  runScalabilityTest();

  console.log();
  runFuzzyMatchingTest();

  console.log();
  runExactMatchTest();

  console.log("=".repeat(80));
  console.log("BENCHMARK COMPLETE");
  console.log("=".repeat(80));
  console.log();
}

module.exports = {
  runBenchmarkSuite,
  runScalabilityTest,
  runFuzzyMatchingTest,
  runExactMatchTest,
};
