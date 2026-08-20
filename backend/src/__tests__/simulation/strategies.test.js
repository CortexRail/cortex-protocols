/**
 * Unit tests for each behaviour strategy's decision logic in isolation.
 *
 * Strategies are pure, so nothing here needs a network, a database, or a clock.
 */

const {
  STRATEGIES,
  GreedyBuyer,
  LoyalBuyer,
  FlakySeller,
  HighVolumeCaller,
  getStrategy,
  expandMix,
  cheapest,
} = require("../../simulation/strategies");
const { createRng } = require("../../simulation/rng");

const CANDIDATES = [
  { id: 1, price: 100, owner: "GSELLER_A" },
  { id: 2, price: 250, owner: "GSELLER_B" },
  { id: 3, price: 90, owner: "GSELLER_C" },
];

function memory(sellers = []) {
  return { sellersUsed: new Set(sellers), callsMade: 0 };
}

describe("cheapest", () => {
  it("returns the lowest-priced candidate", () => {
    expect(cheapest(CANDIDATES).id).toBe(3);
  });

  it("breaks price ties on the lowest id", () => {
    const tied = [
      { id: 9, price: 50, owner: "A" },
      { id: 2, price: 50, owner: "B" },
    ];
    expect(cheapest(tied).id).toBe(2);
  });

  it("returns null for an empty list", () => {
    expect(cheapest([])).toBeNull();
  });
});

describe("GreedyBuyer", () => {
  it("always takes the cheapest quote", () => {
    expect(GreedyBuyer.chooseAsset(CANDIDATES, memory()).id).toBe(3);
  });

  it("ignores which sellers it has used before", () => {
    const chosen = GreedyBuyer.chooseAsset(CANDIDATES, memory(["GSELLER_B"]));
    expect(chosen.id).toBe(3);
  });

  it("never drops its own calls", () => {
    const rng = createRng(1);
    for (let i = 0; i < 50; i++) expect(GreedyBuyer.shouldDropCall(rng)).toBe(false);
  });
});

describe("LoyalBuyer", () => {
  it("prefers a seller it has bought from before, even when pricier", () => {
    const chosen = LoyalBuyer.chooseAsset(CANDIDATES, memory(["GSELLER_B"]));
    expect(chosen.owner).toBe("GSELLER_B");
    expect(chosen.price).toBe(250);
  });

  it("picks the cheapest among several known sellers", () => {
    const chosen = LoyalBuyer.chooseAsset(CANDIDATES, memory(["GSELLER_A", "GSELLER_B"]));
    expect(chosen.owner).toBe("GSELLER_A");
  });

  it("falls back to the cheapest when it knows nobody on offer", () => {
    expect(LoyalBuyer.chooseAsset(CANDIDATES, memory(["GSTRANGER"])).id).toBe(3);
  });

  it("returns null when there is nothing to choose from", () => {
    expect(LoyalBuyer.chooseAsset([], memory())).toBeNull();
  });
});

describe("FlakySeller", () => {
  it("drops roughly a quarter of its calls", () => {
    const rng = createRng(42);
    let dropped = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) if (FlakySeller.shouldDropCall(rng)) dropped++;

    const rate = dropped / trials;
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.3);
  });

  it("injects response latency within its documented bound", () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i++) {
      const delay = FlakySeller.responseDelayMs(rng);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it("is deterministic for a given seed", () => {
    const sequence = (seed) => {
      const rng = createRng(seed);
      return Array.from({ length: 20 }, () => FlakySeller.shouldDropCall(rng));
    };

    expect(sequence(5)).toEqual(sequence(5));
    expect(sequence(5)).not.toEqual(sequence(6));
  });
});

describe("HighVolumeCaller", () => {
  it("never waits between calls", () => {
    expect(HighVolumeCaller.callDelayMs()).toBe(0);
  });

  it("carries a far larger call budget than the other strategies", () => {
    expect(HighVolumeCaller.maxCalls()).toBeGreaterThan(GreedyBuyer.maxCalls());
    expect(HighVolumeCaller.maxCalls()).toBeGreaterThan(FlakySeller.maxCalls());
  });

  it("deposits more so the budget is not the binding constraint", () => {
    expect(HighVolumeCaller.depositXlm()).toBeGreaterThan(GreedyBuyer.depositXlm());
  });
});

describe("getStrategy", () => {
  it("resolves every registered strategy by name", () => {
    for (const name of Object.keys(STRATEGIES)) {
      expect(getStrategy(name).name).toBe(name);
    }
  });

  it("throws with the available names on an unknown strategy", () => {
    expect(() => getStrategy("Nope")).toThrow(/GreedyBuyer/);
  });
});

describe("expandMix", () => {
  it("produces exactly the requested number of agents", () => {
    const agents = expandMix({ GreedyBuyer: 4, LoyalBuyer: 3, FlakySeller: 2, HighVolumeCaller: 1 }, 50);
    expect(agents).toHaveLength(50);
  });

  it("respects the relative weights", () => {
    const agents = expandMix({ GreedyBuyer: 3, FlakySeller: 1 }, 40);
    const greedy = agents.filter((a) => a.name === "GreedyBuyer").length;
    expect(greedy).toBe(30);
    expect(agents.filter((a) => a.name === "FlakySeller")).toHaveLength(10);
  });

  it("gives rounding remainder to the heaviest strategy", () => {
    const agents = expandMix({ GreedyBuyer: 4, LoyalBuyer: 3, FlakySeller: 2, HighVolumeCaller: 1 }, 5);
    expect(agents).toHaveLength(5);
    expect(agents.filter((a) => a.name === "GreedyBuyer").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an empty mix", () => {
    expect(() => expandMix({}, 10)).toThrow(/at least one strategy/);
    expect(() => expandMix({ GreedyBuyer: 0 }, 10)).toThrow(/at least one strategy/);
  });
});
