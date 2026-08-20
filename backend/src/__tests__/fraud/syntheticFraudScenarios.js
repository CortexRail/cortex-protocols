/**
 * Synthetic fraud corpus for the backtest harness.
 *
 * Each scenario builds a deterministic event history plus the labels saying
 * which subjects are fraudulent and which are legitimate, so the backtest
 * runner can compute precision and recall against a known ground truth.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  KNOWN GAPS UNDER TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two scenarios below are NOT regression tests for behaviour that works.
 * They are executable statements of behaviour we know is currently wrong, kept
 * here so the backtest measures the gap instead of us forgetting it exists.
 * Both were found by reading the detectors, and both were reproduced with the
 * numbers recorded in KNOWN_GAPS.
 *
 * A scenario in this file whose `status` is "open" is EXPECTED to fail its
 * target assertion today. The runner must report it as a known gap rather than
 * failing CI — see the `status` field on each entry.
 *
 *   GAP-B  Baseline outliers mask a later genuine spike (recall failure).
 *   GAP-C  A large dense cluster is flagged as sybil on structure alone, with
 *          no corroborating funding or timing evidence (precision failure).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 4 extends this file with the rest of the corpus — an 8-wallet sybil
 * ring, a wash-trading loop, a plain velocity spike, and the clean controls
 * for each — and wires the precision/recall thresholds into CI. The two
 * scenarios here are deliberately the awkward ones.
 *
 * Addresses are synthetic and not StrKey-checksum-valid. That is fine for the
 * tables these scenarios populate (usage_events, agent_funding_sources and the
 * edge queries all store addresses as plain TEXT); do not route them through
 * the HTTP layer, which validates the checksum.
 */

const HOUR_MS = 3_600_000;

/** Deterministic synthetic address. */
function addr(label, index) {
  return `G${label.toUpperCase()}${String(index).padStart(4, "0")}`;
}

/** Align a timestamp to the bucket grid the detectors aggregate on. */
function alignToHour(timestamp) {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

/**
 * Expand a per-hour call count into individual usage_events rows.
 *
 * Rows land one second into their bucket so they can never drift into the
 * neighbouring one, and each carries a unique payload hash so the replay
 * detector has nothing to say about these scenarios.
 */
function callsInBucket({ bucketStart, count, assetId, caller, counterparty, tag }) {
  return Array.from({ length: count }, (_, i) => ({
    source: "stream",
    assetId,
    caller,
    counterparty,
    payloadHash: `${tag}-${bucketStart}-${i}`,
    pricePaid: 100,
    occurredAt: bucketStart + 1_000,
  }));
}

// ══════════════════════════════════════════════════════════════════════════
//  GAP-B — a benign past spike hides the fraud spike that follows
// ══════════════════════════════════════════════════════════════════════════

/**
 * An asset with a steady baseline, one legitimate traffic spike earlier in the
 * window (a launch, a link from a popular feed), and a genuine fraud spike in
 * the current bucket.
 *
 * VelocityDetector computes the baseline standard deviation over the raw
 * series, so the benign spike inflates it enough that the later fraud spike
 * scores inside the normal band. The `control` variant is the identical
 * history WITHOUT the benign spike, which does fire — running both is what
 * isolates the masking effect from everything else.
 *
 * The fix under consideration is Winsorizing the baseline (clamping values
 * above a high percentile before computing the deviation). It is deliberately
 * not implemented yet: it changes the detection curve, and the percentile
 * should be chosen against this corpus rather than guessed.
 *
 * @param {{now?: number}} [options]
 */
function benignSpikeThenFraudSpike({ now = Date.now() } = {}) {
  const currentBucket = alignToHour(now);
  const to = currentBucket + HOUR_MS;
  const from = to - 24 * HOUR_MS;

  const owner = addr("seller", 1);
  const buyer = addr("buyer", 1);
  const assetId = 9001;

  const BASELINE_CALLS = 20;
  const BENIGN_SPIKE_CALLS = 300; // hour 18 of the window: legitimate burst
  const FRAUD_SPIKE_CALLS = 150; // current bucket: the spike we must catch
  const BENIGN_SPIKE_HOURS_AGO = 18;

  const build = ({ withBenignSpike }) => {
    const events = [];

    // 23 baseline buckets, one of which may carry the benign spike.
    for (let hoursAgo = 23; hoursAgo >= 1; hoursAgo -= 1) {
      const isBenignSpike = withBenignSpike && hoursAgo === BENIGN_SPIKE_HOURS_AGO;
      events.push(
        ...callsInBucket({
          bucketStart: currentBucket - hoursAgo * HOUR_MS,
          count: isBenignSpike ? BENIGN_SPIKE_CALLS : BASELINE_CALLS,
          assetId,
          caller: buyer,
          counterparty: owner,
          tag: "gapb",
        })
      );
    }

    // The current bucket: the fraud spike.
    events.push(
      ...callsInBucket({
        bucketStart: currentBucket,
        count: FRAUD_SPIKE_CALLS,
        assetId,
        caller: buyer,
        counterparty: owner,
        tag: "gapb-now",
      })
    );

    return events;
  };

  return {
    name: "benign-spike-then-fraud-spike",
    kind: "fraud",
    gap: "GAP-B",
    description:
      "A legitimate traffic spike earlier in the window inflates the baseline " +
      "deviation enough to hide a genuine fraud spike in the current bucket.",
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner })],
    licenses: [
      { assetId, buyer, licenseType: "UsageBased", pricePaid: 1_000_000, callsRemaining: 500 },
    ],
    streams: [],
    funding: [],

    /** The scenario proper: benign spike present, fraud spike must still fire. */
    usageEvents: build({ withBenignSpike: true }),

    /**
     * Same history minus the benign spike. Fires today, and exists so the
     * runner can attribute the miss to the outlier rather than to the spike
     * being too small.
     */
    control: {
      name: "fraud-spike-without-benign-outlier",
      usageEvents: build({ withBenignSpike: false }),
      expected: { velocityFires: true },
    },

    labels: {
      fraud: [{ detector: "velocity", agentAddress: owner, assetId }],
      fraudAddresses: [owner, buyer],
    },

    expected: {
      // What the acceptance criteria require...
      velocityFires: true,
      // ...and what actually happens today. See KNOWN_GAPS.GAP_B.
      currentlyFires: false,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  GAP-C — a large dense cluster flagged on structure alone
// ══════════════════════════════════════════════════════════════════════════

/**
 * A large, densely interconnected group of addresses with NO funding data and
 * NO metered activity, so neither of the sybil detector's two strong signals
 * is measurable.
 *
 * SybilGraphDetector renormalizes its weighted average over the sub-signals it
 * could measure — the mechanism that stops an empty agent_funding_sources
 * table from capping every real cluster below the firing threshold. The side
 * effect is that when BOTH strong signals drop out, the remaining weight sits
 * entirely on size and density, and structure alone can carry a cluster over
 * the threshold.
 *
 * The issue's acceptance criteria say a sybil flag must rest on evidence of
 * one operator behind many wallets. Size and density are not that: a busy
 * marketplace segment, a consortium, or an integration partner and its
 * customers all look like this. The open question this scenario exists to
 * settle is whether firing should REQUIRE at least one strong signal, or
 * whether a structure-only cluster should be capped at a lower tier.
 *
 * Edges are built from licence relationships only, deliberately: those feed
 * the graph but not `activityTimingByAddress`, which reads usage_events. That
 * is what makes the timing sub-signal unmeasurable rather than merely weak.
 *
 * @param {{now?: number, size?: number}} [options]
 */
function largeDenseClusterWithoutStrongSignals({ now = Date.now(), size = 20 } = {}) {
  const currentBucket = alignToHour(now);
  const to = currentBucket + HOUR_MS;
  const from = to - 24 * HOUR_MS;

  const members = Array.from({ length: size }, (_, i) => addr("dense", i));

  // Every member lists one asset, and buys from the next three members'
  // assets, wrapping around. Dense enough to look cohesive, sparse enough to
  // stay plausible as real trade between real businesses.
  const assets = members.map((owner, i) => makeAsset({ id: 9_700 + i, owner }));
  const licenses = [];
  const licenseEdges = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let step = 1; step <= 3; step += 1) {
      const targetIndex = (i + step) % members.length;
      if (targetIndex === i) continue;

      licenses.push({
        assetId: assets[targetIndex].id,
        buyer: members[i],
        licenseType: "UsageBased",
        pricePaid: 1_000,
        callsRemaining: 100,
      });
      // Pre-aggregated form, for callers driving the detector with fakes.
      licenseEdges.push({
        from: members[i],
        to: members[targetIndex],
        relations: 1,
        value: 1_000,
        firstSeen: from + i * HOUR_MS,
        lastSeen: to,
      });
    }
  }

  return {
    name: "large-dense-cluster-without-strong-signals",
    kind: "control",
    gap: "GAP-C",
    description:
      "A large, dense cluster with no funding data and no metered activity, so " +
      "only size and density are measurable. Structure alone should not be a " +
      "sybil finding.",
    window: { from, to },
    assets,
    licenses,
    streams: [],

    // Both strong signals deliberately absent: no funding rows, and no usage
    // events at all so `activityTimingByAddress` has nothing to measure.
    funding: [],
    usageEvents: [],

    licenseEdges,
    members,

    labels: {
      fraud: [],
      // Every member is legitimate: flagging any of them is a false positive.
      fraudAddresses: [],
    },

    expected: {
      // What the acceptance criteria require...
      sybilFires: false,
      // ...and what actually happens today. See KNOWN_GAPS.GAP_C.
      currentlyFires: true,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  Main corpus — fraud patterns and their controls
// ══════════════════════════════════════════════════════════════════════════
//
// Every scenario emits rows in the shape the repositories accept, so the
// backtest seeds a real database and runs the production pipeline over it
// rather than a re-implementation of it.
//
// `labels.fraud` lists the detections the corpus demands (recall); every
// address NOT in `labels.fraudAddresses` is legitimate, and a signal on one is
// a false positive (precision). Keeping precision at the address level rather
// than the detector level is deliberate: a wash-trading ring is genuinely also
// a sybil cluster, and penalising the sybil detector for noticing would be
// scoring the corpus, not the detectors.

/** The 24h window a scenario spans, aligned to the bucket grid. */
function windowFor(now) {
  const currentBucket = alignToHour(now);
  const to = currentBucket + HOUR_MS;
  return { currentBucket, from: to - 24 * HOUR_MS, to };
}

function makeAsset({ id, owner, licenseType = "UsageBased", price = 1_000_000 }) {
  return {
    id,
    owner,
    name: `Synthetic asset ${id}`,
    description: "Generated by the fraud backtest corpus.",
    assetType: "Prompt",
    licenseType,
    price,
    version: 1,
    usageCount: 0,
    isActive: true,
    tags: ["synthetic"],
  };
}

function makeStream({ id, sender, recipient, now }) {
  const seconds = Math.floor(now / 1000);
  return {
    id,
    sender,
    recipient,
    token: "native",
    deposit: 10_000_000,
    ratePerSecond: 100,
    startTime: seconds - 3_600,
    endTime: seconds + 86_400,
    status: "Active",
    withdrawn: 0,
  };
}

/**
 * A sybil ring: one operator, eight wallets, all funded from the same place
 * and all waking up within minutes of each other.
 *
 * The wallets buy the operator's asset (buyer→owner edges), stream to each
 * other in a loop (wallet→wallet edges), and meter a handful of calls with
 * tightly clustered timestamps. All four sybil sub-signals are measurable.
 *
 * Wash usage is expected to fire here too, and that is correct rather than a
 * false positive: a ring buying its own operator's asset IS self-dealing. The
 * two detectors corroborating is what should push this to the critical tier.
 */
function sybilRing({ now = Date.now(), size = 8 } = {}) {
  const { from, to } = windowFor(now);
  const operator = addr("ringop", 0);
  const wallets = Array.from({ length: size }, (_, i) => addr("ring", i));
  const assetId = 9101;
  const fundingSource = addr("funder", 1);

  const usageEvents = [];
  wallets.forEach((wallet, i) => {
    for (let call = 0; call < 3; call += 1) {
      usageEvents.push({
        source: "stream",
        assetId,
        caller: wallet,
        counterparty: operator,
        payloadHash: `ring-${i}-${call}`,
        pricePaid: 1_000,
        // Every wallet's first call within a five-minute span.
        occurredAt: from + i * 40_000 + call * 1_000,
      });
    }
  });

  return {
    name: "sybil-ring",
    kind: "fraud",
    description: `${size} wallets behind one operator: shared funder, ring-shaped streams, synchronised first activity.`,
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner: operator })],
    licenses: wallets.map((buyer) => ({
      assetId,
      buyer,
      licenseType: "UsageBased",
      pricePaid: 1_000_000,
      callsRemaining: 100,
    })),
    streams: wallets.map((wallet, i) =>
      makeStream({
        id: 91_000 + i,
        sender: wallet,
        recipient: wallets[(i + 1) % wallets.length],
        now,
      })
    ),
    usageEvents,
    funding: [operator, ...wallets].map((agentAddress) => ({
      agentAddress,
      fundingSource,
      firstFundedAt: from - HOUR_MS,
    })),
    labels: {
      fraud: [
        ...wallets.map((agentAddress) => ({ detector: "sybil_graph", agentAddress })),
        { detector: "sybil_graph", agentAddress: operator },
      ],
      fraudAddresses: [operator, ...wallets],
    },
  };
}

/**
 * A wash-trading loop: an owner whose asset's usage comes overwhelmingly from
 * wallets tied back to them, padded with a couple of genuine outside buyers so
 * the insider share is high but not trivially 100%.
 *
 * The insiders are interlinked, which is what makes them reachable from the
 * owner by a path that does not use the purchase edge under investigation —
 * the distinction between "my customer" and "my other wallet".
 */
function washTradingLoop({ now = Date.now() } = {}) {
  const { from, to, currentBucket } = windowFor(now);
  const owner = addr("washowner", 0);
  const insiders = Array.from({ length: 6 }, (_, i) => addr("washin", i));
  const outsiders = Array.from({ length: 2 }, (_, i) => addr("washout", i));
  const assetId = 9201;

  const usageEvents = [];
  insiders.forEach((insider, i) => {
    for (let call = 0; call < 12; call += 1) {
      usageEvents.push({
        source: "stream",
        assetId,
        caller: insider,
        counterparty: owner,
        payloadHash: `wash-in-${i}-${call}`,
        pricePaid: 1_000,
        occurredAt: currentBucket - (call + 2) * HOUR_MS + i * 1_000,
      });
    }
  });
  outsiders.forEach((outsider, i) => {
    for (let call = 0; call < 5; call += 1) {
      usageEvents.push({
        source: "stream",
        assetId,
        caller: outsider,
        counterparty: owner,
        payloadHash: `wash-out-${i}-${call}`,
        pricePaid: 1_000,
        occurredAt: currentBucket - (call + 2) * HOUR_MS + 30_000,
      });
    }
  });

  return {
    name: "wash-trading-loop",
    kind: "fraud",
    description:
      "72 of 82 calls on the owner's asset come from six interlinked wallets tied back to the owner.",
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner })],
    licenses: [...insiders, ...outsiders].map((buyer) => ({
      assetId,
      buyer,
      licenseType: "UsageBased",
      pricePaid: 1_000_000,
      callsRemaining: 100,
    })),
    // Insider ↔ insider links, independent of the purchases being measured.
    streams: insiders.map((insider, i) =>
      makeStream({
        id: 92_000 + i,
        sender: insider,
        recipient: insiders[(i + 1) % insiders.length],
        now,
      })
    ),
    usageEvents,
    funding: [],
    labels: {
      fraud: [{ detector: "wash_usage", agentAddress: owner, assetId }],
      fraudAddresses: [owner, ...insiders],
    },
  };
}

/**
 * A genuine velocity spike: an established, boring baseline and then a burst
 * an order of magnitude above it in the current bucket.
 */
function velocitySpike({ now = Date.now() } = {}) {
  const { from, to, currentBucket } = windowFor(now);
  const owner = addr("velowner", 0);
  const buyer = addr("velbuyer", 0);
  const assetId = 9301;

  const usageEvents = [];
  for (let hoursAgo = 23; hoursAgo >= 1; hoursAgo -= 1) {
    usageEvents.push(
      ...callsInBucket({
        bucketStart: currentBucket - hoursAgo * HOUR_MS,
        count: 6,
        assetId,
        caller: buyer,
        counterparty: owner,
        tag: "vel-base",
      })
    );
  }
  usageEvents.push(
    ...callsInBucket({
      bucketStart: currentBucket,
      count: 60,
      assetId,
      caller: buyer,
      counterparty: owner,
      tag: "vel-spike",
    })
  );

  return {
    name: "velocity-spike",
    kind: "fraud",
    description: "23 hours at 6 calls/hour, then 60 in the current bucket.",
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner })],
    licenses: [
      { assetId, buyer, licenseType: "UsageBased", pricePaid: 1_000_000, callsRemaining: 500 },
    ],
    streams: [],
    usageEvents,
    funding: [],
    labels: {
      fraud: [{ detector: "velocity", agentAddress: owner, assetId }],
      fraudAddresses: [owner, buyer],
    },
  };
}

/**
 * Replay abuse: a buyer metering the same handful of payloads over and over on
 * a usage-based asset.
 *
 * The calls are spread thinly across the window on purpose so this scenario
 * isolates the replay signal instead of also tripping velocity.
 */
function replayAbuse({ now = Date.now() } = {}) {
  const { from, to, currentBucket } = windowFor(now);
  const owner = addr("repowner", 0);
  const replayer = addr("replayer", 0);
  const assetId = 9401;

  const usageEvents = [];
  for (let i = 0; i < 40; i += 1) {
    usageEvents.push({
      source: "stream",
      assetId,
      caller: replayer,
      counterparty: owner,
      // Only four distinct payloads across forty billed calls.
      payloadHash: `replay-payload-${i % 4}`,
      pricePaid: 1_000,
      occurredAt: currentBucket - (2 + (i % 10)) * HOUR_MS + i * 1_000,
    });
  }

  return {
    name: "replay-abuse",
    kind: "fraud",
    description: "40 billed calls, 4 distinct payloads, on a usage-based asset.",
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner, licenseType: "UsageBased" })],
    licenses: [
      {
        assetId,
        buyer: replayer,
        licenseType: "UsageBased",
        pricePaid: 1_000_000,
        callsRemaining: 500,
      },
    ],
    streams: [],
    usageEvents,
    funding: [],
    labels: {
      fraud: [{ detector: "replay_abuse", agentAddress: replayer, assetId }],
      fraudAddresses: [replayer],
    },
  };
}

/**
 * CONTROL — an ordinary marketplace segment: one seller, ten unrelated buyers,
 * steady traffic, unique payloads, no shared funding, activity spread across
 * the day.
 *
 * Structurally this is a star with eleven nodes, which is exactly what a
 * naively-tuned sybil detector flags. Nothing here may fire.
 */
function organicMarketplace({ now = Date.now() } = {}) {
  const { from, to, currentBucket } = windowFor(now);
  const seller = addr("orgseller", 0);
  const buyers = Array.from({ length: 10 }, (_, i) => addr("orgbuyer", i));
  const assetId = 9501;

  const usageEvents = [];
  buyers.forEach((buyer, i) => {
    for (let call = 0; call < 6; call += 1) {
      usageEvents.push({
        source: "stream",
        assetId,
        caller: buyer,
        counterparty: seller,
        payloadHash: `organic-${i}-${call}`,
        pricePaid: 1_000,
        // Buyers arrive hours apart, the way unrelated people do.
        occurredAt: currentBucket - (2 + i * 2) * HOUR_MS + call * 60_000,
      });
    }
  });

  return {
    name: "organic-marketplace",
    kind: "control",
    description: "One seller, ten unrelated buyers, steady traffic across the day.",
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner: seller })],
    licenses: buyers.map((buyer) => ({
      assetId,
      buyer,
      licenseType: "UsageBased",
      pricePaid: 1_000_000,
      callsRemaining: 100,
    })),
    streams: [],
    usageEvents,
    funding: [],
    labels: { fraud: [], fraudAddresses: [] },
  };
}

/**
 * CONTROL — a legitimately popular asset whose traffic climbs steeply.
 *
 * This is the hardest control in the corpus and the reason the velocity
 * precision target is lower than the others: a real launch and an inflated one
 * have the same shape in the usage log. The demand here is not that velocity
 * stays silent — it is that a single-detector spike from unrelated buyers must
 * not reach the critical tier, and that no structural detector fires.
 */
function viralAsset({ now = Date.now() } = {}) {
  const { from, to, currentBucket } = windowFor(now);
  const seller = addr("viralseller", 0);
  const buyers = Array.from({ length: 12 }, (_, i) => addr("viralbuyer", i));
  const assetId = 9601;

  const usageEvents = [];
  // A quiet day...
  for (let hoursAgo = 23; hoursAgo >= 2; hoursAgo -= 1) {
    for (let call = 0; call < 3; call += 1) {
      usageEvents.push({
        source: "stream",
        assetId,
        caller: buyers[(hoursAgo + call) % buyers.length],
        counterparty: seller,
        payloadHash: `viral-base-${hoursAgo}-${call}`,
        pricePaid: 1_000,
        occurredAt: currentBucket - hoursAgo * HOUR_MS + call * 1_000,
      });
    }
  }
  // ...and then the asset gets noticed, by many unrelated buyers at once.
  for (let call = 0; call < 60; call += 1) {
    usageEvents.push({
      source: "stream",
      assetId,
      caller: buyers[call % buyers.length],
      counterparty: seller,
      payloadHash: `viral-burst-${call}`,
      pricePaid: 1_000,
      occurredAt: currentBucket + call * 1_000,
    });
  }

  return {
    name: "viral-asset",
    kind: "control",
    description: "A legitimate launch: quiet baseline, then a burst from twelve unrelated buyers.",
    window: { from, to },
    assets: [makeAsset({ id: assetId, owner: seller })],
    licenses: buyers.map((buyer) => ({
      assetId,
      buyer,
      licenseType: "UsageBased",
      pricePaid: 1_000_000,
      callsRemaining: 100,
    })),
    streams: [],
    usageEvents,
    funding: [],
    labels: { fraud: [], fraudAddresses: [] },
    // Velocity may fire; the tier ceiling is what this control enforces.
    tolerates: { detectors: ["velocity"], maxTier: "high" },
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  Gap register
// ══════════════════════════════════════════════════════════════════════════

/**
 * Machine-readable record of the gaps these scenarios cover.
 *
 * `status: "open"` means the scenario is expected to fail its target assertion
 * today. The backtest runner reports open gaps separately instead of failing
 * CI on them; flipping a gap to "closed" is what turns it into a regression
 * test. Measured values come from running the detectors directly — they are
 * observations, not predictions, and should be re-measured when the detectors
 * change.
 */
const KNOWN_GAPS = Object.freeze({
  GAP_B: Object.freeze({
    id: "GAP-B",
    title: "Baseline outliers mask a later genuine spike",
    detector: "velocity",
    kind: "recall",
    scenario: "benign-spike-then-fraud-spike",
    status: "open",
    // Measured from this scenario on 2026-08-19.
    currentBehaviour:
      "The 300-call benign spike at hour 18 lifts the baseline mean to 32.2 " +
      "and its standard deviation to 58.4, so the genuine 150-call spike in " +
      "the current bucket scores z=2.02 and stays inside the normal band. The " +
      "identical history without the outlier scores z=130.00 and fires, which " +
      "is what attributes the miss to the outlier rather than to spike size.",
    targetBehaviour:
      "The fraud spike fires despite an unrelated benign outlier earlier in " +
      "the window.",
    candidateFix:
      "Winsorize the baseline (clamp above ~p90) before computing the standard " +
      "deviation. The percentile should be chosen by sweeping it against this " +
      "corpus, not guessed.",
  }),

  GAP_C: Object.freeze({
    id: "GAP-C",
    title: "Sybil cluster fires on size and density alone",
    detector: "sybil_graph",
    kind: "precision",
    scenario: "large-dense-cluster-without-strong-signals",
    status: "open",
    // Measured from this scenario on 2026-08-19.
    currentBehaviour:
      "With funding and timing both unmeasurable, renormalization leaves only " +
      "0.35 of the total 1.0 weight in play (size 0.15 + density 0.20). A " +
      "20-address cluster with 60 licence edges (density 0.32) scores size=1.00 " +
      "and density=0.20, clearing the 0.5 threshold at 0.54 and emitting a " +
      "signal for all 20 members — 20 false positives from structure alone.",
    targetBehaviour:
      "A sybil finding rests on evidence of one operator behind many wallets. " +
      "Structure alone should either not fire, or fire at a capped lower tier.",
    candidateFix:
      "Require at least one strong signal (funding or timing) to be measurable " +
      "and non-zero before firing, or cap structure-only clusters below the " +
      "reportable tiers. Decide against measured precision on the full corpus.",
  }),
});

/**
 * The corpus the backtest enforces thresholds over — scenarios NOT tied to an
 * open gap. Keeping the enforced set separate from the gap set is what stops
 * "known gap" from becoming a place to hide every inconvenient failure: adding
 * a scenario here is the default, and moving one out requires a register entry
 * with measured evidence and a candidate fix.
 */
const ENFORCED_CORPUS = Object.freeze([
  sybilRing,
  washTradingLoop,
  velocitySpike,
  replayAbuse,
  organicMarketplace,
  viralAsset,
]);

/** Scenarios that exercise an open gap and are reported rather than enforced. */
const GAP_CORPUS = Object.freeze([
  benignSpikeThenFraudSpike,
  largeDenseClusterWithoutStrongSignals,
]);

const SCENARIOS = Object.freeze({
  sybilRing,
  washTradingLoop,
  velocitySpike,
  replayAbuse,
  organicMarketplace,
  viralAsset,
  benignSpikeThenFraudSpike,
  largeDenseClusterWithoutStrongSignals,
});

module.exports = {
  HOUR_MS,
  addr,
  alignToHour,
  callsInBucket,
  windowFor,
  makeAsset,
  makeStream,
  sybilRing,
  washTradingLoop,
  velocitySpike,
  replayAbuse,
  organicMarketplace,
  viralAsset,
  benignSpikeThenFraudSpike,
  largeDenseClusterWithoutStrongSignals,
  KNOWN_GAPS,
  SCENARIOS,
  ENFORCED_CORPUS,
  GAP_CORPUS,
};
