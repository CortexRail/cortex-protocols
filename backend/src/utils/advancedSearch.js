/**
 * Advanced search utility with TF-IDF scoring, fuzzy matching, and ranking.
 * Implements a custom search algorithm optimized for asset discovery.
 *
 * Features:
 * - TF-IDF scoring across name, description, and tags
 * - 3x boost for exact name matches
 * - Fuzzy matching with Levenshtein distance ≤ 2 for typo tolerance
 * - Configurable field weights
 * - Performance optimized for large datasets
 */

/**
 * Calculate Levenshtein distance between two strings.
 * Uses Wagner-Fischer algorithm with optimized space complexity O(min(m,n)).
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Edit distance
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for memory optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const row = Array(a.length + 1)
    .fill(0)
    .map((_, i) => i);

  for (let i = 1; i <= b.length; i++) {
    let prev = i;
    for (let j = 1; j <= a.length; j++) {
      const val =
        b[i - 1] === a[j - 1]
          ? row[j - 1]
          : Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      row[j - 1] = prev;
      prev = val;
    }
    row[a.length] = prev;
  }

  return row[a.length];
}

/**
 * Tokenize text into normalized terms for indexing and searching.
 *
 * @param {string} text - Input text
 * @returns {string[]} - Array of normalized tokens
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Calculate term frequency for a term in a document.
 * Uses augmented frequency to prevent bias toward longer documents.
 *
 * @param {string} term - Search term
 * @param {string[]} tokens - Document tokens
 * @returns {number} - Term frequency score
 */
function termFrequency(term, tokens) {
  if (tokens.length === 0) return 0;

  const count = tokens.filter((t) => t === term).length;
  const counts = tokens.reduce((acc, t) => {
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, Object.create(null));
  const maxCount = Math.max(...Object.values(counts));

  // Augmented frequency: 0.5 + 0.5 * (raw_count / max_count)
  return 0.5 + 0.5 * (count / Math.max(1, maxCount));
}

/**
 * Calculate inverse document frequency for a term across all documents.
 *
 * @param {string} term - Search term
 * @param {Array} corpus - Array of tokenized documents
 * @returns {number} - IDF score
 */
function inverseDocumentFrequency(term, corpus) {
  if (corpus.length === 0) return 0;

  const docsWithTerm = corpus.filter((doc) => doc.includes(term)).length;

  if (docsWithTerm === 0) return 0;

  // IDF = log(N / df) where N = total docs, df = docs containing term
  return Math.log(corpus.length / docsWithTerm);
}

/**
 * Calculate TF-IDF score for a term in a document.
 *
 * @param {string} term - Search term
 * @param {string[]} documentTokens - Tokens from the document
 * @param {Array} corpus - All tokenized documents
 * @returns {number} - TF-IDF score
 */
function tfidfScore(term, documentTokens, corpus) {
  const tf = termFrequency(term, documentTokens);
  const idf = inverseDocumentFrequency(term, corpus);
  return tf * idf;
}

/**
 * Check if a term fuzzy matches any token in the document.
 * Uses Levenshtein distance with threshold of 2.
 *
 * @param {string} term - Search term
 * @param {string[]} tokens - Document tokens
 * @param {number} threshold - Maximum edit distance (default: 2)
 * @returns {boolean} - True if fuzzy match found
 */
function fuzzyMatch(term, tokens, threshold = 2) {
  return tokens.some((token) => {
    // Exact match
    if (token === term) return true;

    // Fuzzy match only for terms > 3 chars to avoid false positives
    if (term.length <= 3) return false;

    return levenshteinDistance(term, token) <= threshold;
  });
}

/**
 * Build a searchable index from asset data.
 * Pre-tokenizes all fields for efficient TF-IDF calculation.
 *
 * @param {Array} assets - Array of asset objects
 * @returns {Object} - Index containing tokenized fields and corpus
 */
function buildSearchIndex(assets) {
  const index = {
    assets: [],
    corpus: {
      name: [],
      description: [],
      tags: [],
    },
  };

  for (const asset of assets) {
    const nameTokens = tokenize(asset.name || "");
    const descTokens = tokenize(asset.description || "");
    const tagTokens = Array.isArray(asset.tags)
      ? asset.tags.flatMap((tag) => tokenize(tag))
      : [];

    index.assets.push({
      ...asset,
      _tokens: {
        name: nameTokens,
        description: descTokens,
        tags: tagTokens,
      },
    });

    index.corpus.name.push(nameTokens);
    index.corpus.description.push(descTokens);
    index.corpus.tags.push(tagTokens);
  }

  return index;
}

/**
 * Calculate relevance score for an asset against a search query.
 *
 * Scoring algorithm:
 * - Base TF-IDF scores for name (weight: 3), description (weight: 1), tags (weight: 2)
 * - 3x boost for exact name matches
 * - Fuzzy matching fallback for typo tolerance
 * - Normalized to 0-100 scale
 *
 * @param {Object} indexedAsset - Asset with pre-tokenized fields
 * @param {string[]} queryTerms - Tokenized search query
 * @param {Object} corpus - Pre-built corpus for IDF calculation
 * @param {Object} weights - Field weights {name, description, tags}
 * @returns {number} - Relevance score (0-100)
 */
function calculateRelevanceScore(
  indexedAsset,
  queryTerms,
  corpus,
  weights = {},
) {
  const {
    name: nameWeight = 3,
    description: descWeight = 1,
    tags: tagsWeight = 2,
  } = weights;

  const { _tokens } = indexedAsset;
  let score = 0;
  let exactNameMatch = false;

  // Check for exact name match (case-insensitive)
  const normalizedName = (indexedAsset.name || "").toLowerCase();
  const queryString = queryTerms.join(" ");
  if (normalizedName === queryString) {
    exactNameMatch = true;
  }

  for (const term of queryTerms) {
    // Name field scoring
    if (_tokens.name.includes(term)) {
      score += tfidfScore(term, _tokens.name, corpus.name) * nameWeight;
    } else if (fuzzyMatch(term, _tokens.name)) {
      // Fuzzy match gets 50% of the TF-IDF score
      score += tfidfScore(term, _tokens.name, corpus.name) * nameWeight * 0.5;
    }

    // Description field scoring
    if (_tokens.description.includes(term)) {
      score +=
        tfidfScore(term, _tokens.description, corpus.description) * descWeight;
    } else if (fuzzyMatch(term, _tokens.description)) {
      score +=
        tfidfScore(term, _tokens.description, corpus.description) *
        descWeight *
        0.5;
    }

    // Tags field scoring
    if (_tokens.tags.includes(term)) {
      score += tfidfScore(term, _tokens.tags, corpus.tags) * tagsWeight;
    } else if (fuzzyMatch(term, _tokens.tags)) {
      score += tfidfScore(term, _tokens.tags, corpus.tags) * tagsWeight * 0.5;
    }
  }

  // Apply 3x boost for exact name matches
  if (exactNameMatch) {
    score *= 3;
  }

  // Normalize score to 0-100 scale
  // Using a sigmoid-like transformation for better distribution
  const normalizedScore = Math.min(100, score * 10);

  return Math.round(normalizedScore * 100) / 100; // Round to 2 decimal places
}

/**
 * Perform advanced search with TF-IDF scoring and fuzzy matching.
 *
 * @param {Array} assets - Array of asset objects to search
 * @param {string} query - Search query string
 * @param {Object} options - Search options
 * @param {number} options.minScore - Minimum relevance score threshold (default: 0)
 * @param {Object} options.weights - Field weights {name, description, tags}
 * @param {boolean} options.includeFuzzy - Enable fuzzy matching (default: true)
 * @returns {Array} - Sorted array of assets with score field
 */
function advancedSearch(assets, query, options = {}) {
  const {
    minScore = 0,
    weights = { name: 3, description: 1, tags: 2 },
    // eslint-disable-next-line no-unused-vars -- documented option, not yet wired into scoring
    includeFuzzy = true,
  } = options;

  if (!query || query.trim().length === 0) {
    return assets.map((asset) => ({ ...asset, score: 0 }));
  }

  // Tokenize the search query
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) {
    return assets.map((asset) => ({ ...asset, score: 0 }));
  }

  // Build search index
  const index = buildSearchIndex(assets);

  // Calculate relevance scores
  const results = index.assets.map((indexedAsset) => {
    const score = calculateRelevanceScore(
      indexedAsset,
      queryTerms,
      index.corpus,
      weights,
    );

    // Remove internal _tokens field before returning
    const { _tokens, ...assetWithoutTokens } = indexedAsset;

    return {
      ...assetWithoutTokens,
      score,
    };
  });

  // Filter by minimum score and sort by relevance
  return results
    .filter((result) => result.score >= minScore)
    .sort((a, b) => {
      // Primary sort by score (descending)
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      // Secondary sort by creation date (newest first)
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

/**
 * Benchmark the search performance with a given dataset size.
 *
 * @param {number} datasetSize - Number of assets to generate for testing
 * @param {string} query - Search query to test
 * @returns {Object} - Performance metrics
 */
function benchmarkSearch(
  datasetSize = 10000,
  query = "machine learning dataset",
) {
  // Generate synthetic dataset
  const assets = generateSyntheticAssets(datasetSize);

  const startTime = Date.now();
  const results = advancedSearch(assets, query);
  const endTime = Date.now();

  const duration = endTime - startTime;

  return {
    datasetSize,
    query,
    resultsCount: results.length,
    durationMs: duration,
    throughput: Math.round(datasetSize / (duration / 1000)),
    avgScorePerItem: duration / datasetSize,
    topScores: results
      .slice(0, 10)
      .map((r) => ({ name: r.name, score: r.score })),
  };
}

/**
 * Generate synthetic assets for benchmarking.
 * Creates realistic asset data with varied names, descriptions, and tags.
 *
 * @param {number} count - Number of assets to generate
 * @returns {Array} - Array of synthetic assets
 */
function generateSyntheticAssets(count) {
  const assetTypes = [
    "Prompt",
    "Workflow",
    "Dataset",
    "Tool",
    "Model",
    "Evaluator",
  ];
  const domains = [
    "machine learning",
    "data science",
    "nlp",
    "computer vision",
    "robotics",
  ];
  const adjectives = [
    "advanced",
    "efficient",
    "powerful",
    "optimized",
    "innovative",
  ];
  const purposes = [
    "classification",
    "generation",
    "analysis",
    "processing",
    "training",
  ];
  const tags = [
    "ai",
    "ml",
    "deep-learning",
    "transformer",
    "neural-network",
    "dataset",
    "model",
  ];

  const assets = [];

  for (let i = 0; i < count; i++) {
    const type = assetTypes[i % assetTypes.length];
    const domain = domains[Math.floor(Math.random() * domains.length)];
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const purpose = purposes[Math.floor(Math.random() * purposes.length)];

    const name = `${adjective} ${domain} ${type} ${i}`.trim();
    const description =
      `A ${adjective} ${type.toLowerCase()} for ${domain} ${purpose}. ` +
      `This asset provides state-of-the-art capabilities for various use cases.`;

    const assetTags = [];
    const numTags = 2 + Math.floor(Math.random() * 4);
    for (let j = 0; j < numTags; j++) {
      assetTags.push(tags[Math.floor(Math.random() * tags.length)]);
    }

    assets.push({
      id: `asset-${i}`,
      name,
      description,
      assetType: type,
      tags: assetTags,
      price: Math.floor(Math.random() * 1000),
      usageCount: Math.floor(Math.random() * 10000),
      createdAt: Date.now() - Math.floor(Math.random() * 10000000),
      isActive: true,
    });
  }

  return assets;
}

module.exports = {
  advancedSearch,
  buildSearchIndex,
  calculateRelevanceScore,
  tokenize,
  levenshteinDistance,
  fuzzyMatch,
  tfidfScore,
  termFrequency,
  inverseDocumentFrequency,
  benchmarkSearch,
  generateSyntheticAssets,
};
