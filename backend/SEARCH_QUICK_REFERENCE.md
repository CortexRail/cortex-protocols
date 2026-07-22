# Advanced Search - Quick Reference

## 🚀 Quick Start

```bash
# Run interactive demo
node src/examples/searchDemo.js

# Run benchmarks with 10K assets
node src/scripts/benchmarkSearch.js 10000

# Read full documentation
cat docs/ADVANCED_SEARCH.md
```

## 📊 Features at a Glance

| Feature               | Description                               | Status |
| --------------------- | ----------------------------------------- | ------ |
| **TF-IDF Scoring**    | Industry-standard relevance ranking       | ✅     |
| **Exact Match Boost** | 3x multiplier for exact name matches      | ✅     |
| **Fuzzy Matching**    | Levenshtein distance ≤ 2 (typo tolerance) | ✅     |
| **Field Weights**     | name: 3, tags: 2, description: 1          | ✅     |
| **Score Field**       | Returns 0-100 relevance score             | ✅     |
| **Performance**       | Tested with 10,000 assets (~35ms avg)     | ✅     |

## 💡 Usage Examples

### Basic Search

```javascript
const { advancedSearch } = require("./utils/advancedSearch");

const results = advancedSearch(assets, "machine learning");
// Results include score field: { ...asset, score: 87.45 }
```

### With Options

```javascript
const results = advancedSearch(assets, "dataset", {
  minScore: 5, // Filter low scores
  weights: { name: 4, description: 1, tags: 2 }, // Custom weights
  includeFuzzy: true, // Enable typos (default)
});
```

### Repository Integration

```javascript
const results = await assetRepository.search(
  "neural network",
  {
    assetType: "Tool",
    minPrice: 0,
    maxPrice: 100,
  },
  {
    page: 1,
    limit: 20,
  },
);

// Results automatically include score field
console.log(results.data[0].score); // 92.35
```

## 🎯 Search Examples

| Query             | Matches                                 | Notes                       |
| ----------------- | --------------------------------------- | --------------------------- |
| `dataset`         | "Dataset", "ML Dataset", "Dataset Tool" | Exact name match boosted 3x |
| `machne learning` | "Machine Learning", "ML Tool"           | Fuzzy matching handles typo |
| `transformr`      | "Transformer", "Transform"              | Edit distance ≤ 2           |
| `nlp workflow`    | NLP tools, workflows                    | Multi-term matching         |

## 📈 Performance (10K Assets)

```
Average Query Time:    35ms
Throughput:            285K items/s
Memory Usage:          ~10MB
Scalability:           O(n^1.2)
```

## 🔧 Key Functions

### `advancedSearch(assets, query, options)`

Main search function with TF-IDF + fuzzy matching.

**Parameters:**

- `assets` - Array of asset objects
- `query` - Search query string
- `options.minScore` - Minimum score threshold (default: 0)
- `options.weights` - Field weights (default: {name: 3, description: 1, tags: 2})
- `options.includeFuzzy` - Enable fuzzy matching (default: true)

**Returns:** Array of assets with `score` field, sorted by relevance

### `levenshteinDistance(a, b)`

Calculate edit distance between two strings.

**Parameters:**

- `a` - First string
- `b` - Second string

**Returns:** Number of edits needed (0 = identical)

### `tokenize(text)`

Normalize and split text into searchable tokens.

**Parameters:**

- `text` - Input text

**Returns:** Array of lowercase tokens

### `benchmarkSearch(datasetSize, query)`

Run performance benchmark.

**Parameters:**

- `datasetSize` - Number of assets to test (default: 10000)
- `query` - Test query (default: 'machine learning dataset')

**Returns:** Performance metrics object

## 📁 File Structure

```
backend/
├── src/
│   ├── utils/
│   │   └── advancedSearch.js          # Core implementation
│   ├── repositories/
│   │   └── assetRepository.js         # Integration (modified)
│   ├── scripts/
│   │   └── benchmarkSearch.js         # Performance testing
│   └── examples/
│       └── searchDemo.js              # Interactive demo
└── docs/
    ├── ADVANCED_SEARCH.md             # Full documentation
    └── SEARCH_LIBRARY_COMPARISON.md   # Library evaluation
```

## 🎮 Demo Scenarios

Run `node src/examples/searchDemo.js` to see:

1. Multi-word search
2. Exact match boost (3x)
3. Fuzzy matching (typos)
4. Tag-based search
5. Complex queries
6. Low-relevance filtering
7. Custom field weights
8. Multiple typo handling

## 🧪 Testing

```bash
# Full benchmark suite
node src/scripts/benchmarkSearch.js

# Quick test with smaller dataset
node src/scripts/benchmarkSearch.js 1000

# Interactive demo
node src/examples/searchDemo.js
```

## 🎨 Score Interpretation

| Score Range | Label           | Color     | Meaning           |
| ----------- | --------------- | --------- | ----------------- |
| 80-100      | Excellent Match | 🟢 Green  | Highly relevant   |
| 60-79       | Good Match      | 🔵 Blue   | Relevant          |
| 40-59       | Fair Match      | 🟡 Yellow | Somewhat relevant |
| 0-39        | Weak Match      | ⚪ Gray   | Low relevance     |

## ⚡ Performance Tips

1. **Use hybrid search** - Let PostgreSQL filter first
2. **Apply filters** - Reduce dataset with type/price filters
3. **Set minScore** - Filter low-relevance results (e.g., minScore: 5)
4. **Paginate** - Use reasonable page sizes (20-50)
5. **Cache** - Cache common queries at API layer

## 🐛 Troubleshooting

### Low Scores

- ✅ Check field weights
- ✅ Verify tokenization
- ✅ Confirm exact match boost

### Slow Performance

- ✅ Use hybrid search (not advancedSearchOnly)
- ✅ Apply filters to reduce dataset
- ✅ Increase minScore threshold
- ✅ Profile with `node --inspect`

### Missing Results

- ✅ Check `is_active = true`
- ✅ Try `advancedSearchOnly` to bypass DB filter
- ✅ Verify query tokenization
- ✅ Check if filters exclude the asset

## 📚 Documentation

- **Full Docs:** `docs/ADVANCED_SEARCH.md`
- **Comparison:** `docs/SEARCH_LIBRARY_COMPARISON.md`
- **Contribution:** `SEARCH_IMPROVEMENTS.md`
- **This Guide:** `SEARCH_QUICK_REFERENCE.md`

## 🔗 API Response Format

```json
{
  "data": [
    {
      "id": "asset-123",
      "name": "Machine Learning Dataset",
      "description": "...",
      "assetType": "Dataset",
      "tags": ["ml", "dataset"],
      "score": 87.45,
      "..."
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 245,
    "pages": 13
  }
}
```

## ✨ Algorithm Summary

```
1. Tokenize query and documents
2. Calculate TF (term frequency with augmentation)
3. Calculate IDF (inverse document frequency)
4. Compute TF-IDF score per field
5. Apply field weights (name: 3, tags: 2, desc: 1)
6. Check fuzzy matches (Levenshtein ≤ 2)
7. Apply 3x boost for exact name matches
8. Normalize score to 0-100 scale
9. Sort by score (desc), then date (desc)
```

## 🎓 Key Concepts

**TF-IDF:** Measures term importance = frequency × rarity  
**Levenshtein Distance:** Minimum edits to transform string  
**Augmented Frequency:** Prevents bias toward long documents  
**Field Weighting:** Different importance per field  
**Fuzzy Matching:** Tolerance for typos and misspellings

---

**Quick Start:** `node src/examples/searchDemo.js`  
**Full Docs:** `docs/ADVANCED_SEARCH.md`  
**Benchmark:** `node src/scripts/benchmarkSearch.js 10000`
