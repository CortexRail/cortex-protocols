/**
 * Pricing and oracle aggregation endpoints.
 * 
 * GET /api/v1/internal/pricing/oracle-health
 * - Returns per-source staleness and deviation stats for monitoring
 * 
 * GET /api/v1/pricing/sources
 * - Returns configured oracle sources with weights
 */

const { Router } = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const priceOracleAggregator = require("../pricing/PriceOracleAggregator");
const stalenessGuard = require("../pricing/StalenessGuard");

const router = Router();

/**
 * GET /api/v1/internal/pricing/oracle-health
 * Return health status of all oracle sources with staleness and deviation metrics.
 * 
 * Response:
 * {
 *   timestamp: number (ms),
 *   overall: "healthy" | "degraded" | "critical",
 *   sources: [
 *     {
 *       name: string,
 *       status: "available" | "unavailable",
 *       latency: number (ms),
 *       staleness: { freshCount, staleCount, failureRate },
 *       lastUpdate: ISO string
 *     }
 *   ]
 * }
 */
router.get(
  "/oracle-health",
  asyncHandler(async (_req, res) => {
    const oracleHealth = await priceOracleAggregator.getOracleHealth();
    const sourceHealth = stalenessGuard.getAllSourceHealth();

    const enriched = {
      timestamp: Date.now(),
      overall: oracleHealth.overall,
      sources: oracleHealth.sources.map((source) => {
        const health = sourceHealth.find((h) => h.source === source.name);
        return {
          ...source,
          staleness: health
            ? {
                freshCount: health.freshCount,
                staleCount: health.staleCount,
                failureRate: health.failureRate,
                avgAge: health.avgAge,
              }
            : null,
        };
      }),
    };

    res.json(enriched);
  })
);

/**
 * GET /api/v1/pricing/sources
 * List all configured oracle sources with weights and staleness limits.
 */
router.get(
  "/sources",
  asyncHandler(async (_req, res) => {
    const sources = priceOracleAggregator.getConfiguredSources?.() || [];
    res.json({
      count: sources.length,
      sources: sources.map((s) => ({
        name: s.name,
        type: s.type,
        weight: s.weight,
        maxStaleness: s.maxStaleness,
      })),
    });
  })
);

module.exports = router;
