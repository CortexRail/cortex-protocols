const {
  AuctionEngine,
  PHASES,
  broadcast,
  _trackedAuctions,
  _sseClients,
} = require("../protocol/AuctionEngine");

function freshEngine(ledger = 100) {
  return new AuctionEngine({ getLedgerSequence: async () => ledger });
}

beforeEach(() => {
  _trackedAuctions.clear();
  _sseClients.clear();
});

afterAll(() => {
  _trackedAuctions.clear();
  _sseClients.clear();
});

describe("AuctionEngine (mock mode)", () => {
  it("opens the reveal window once the commit window elapses", async () => {
    const engine = freshEngine(100);
    engine.track(1, { phase: "Commit", openLedger: 100, durationLedgers: 10, revealEnd: null });

    // Still inside the commit window.
    expect(await engine.tick()).toEqual([]);

    // Commit window [100, 110) closed.
    engine._getLedgerSequence = async () => 110;
    const transitions = await engine.tick();
    expect(transitions).toEqual([{ auctionId: 1, transition: "begin_reveal", ledger: 110 }]);

    const snapshot = _trackedAuctions.get(1);
    expect(snapshot.phase).toBe(PHASES.REVEAL);
    expect(snapshot.revealEnd).toBe(120);
  });

  it("settles once the reveal window closes", async () => {
    const engine = freshEngine(115);
    engine.track(2, { phase: "Reveal", openLedger: 100, durationLedgers: 10, revealEnd: 120 });

    // Inside the reveal window.
    expect(await engine.tick()).toEqual([]);

    engine._getLedgerSequence = async () => 120;
    const transitions = await engine.tick();
    expect(transitions).toEqual([{ auctionId: 2, transition: "settle_auction", ledger: 120 }]);
    expect(_trackedAuctions.get(2).phase).toBe(PHASES.SETTLED);
  });

  it("honors an anti-sniping-extended reveal window", async () => {
    const engine = freshEngine(124);
    engine.track(3, { phase: "Reveal", openLedger: 100, durationLedgers: 10, revealEnd: 130 });

    // An extension pushed the close from 120 to 130; settling at 124 must
    // not happen.
    expect(await engine.tick()).toEqual([]);

    engine._getLedgerSequence = async () => 130;
    const transitions = await engine.tick();
    expect(transitions).toHaveLength(1);
    expect(transitions[0].transition).toBe("settle_auction");
  });

  it("performs a full lifecycle in one shot: commit -> reveal -> settled", async () => {
    const engine = freshEngine(200);
    engine.track(4, { phase: "Commit", openLedger: 100, durationLedgers: 10, revealEnd: null });

    engine._getLedgerSequence = async () => 110;
    let transitions = await engine.tick();
    expect(transitions).toHaveLength(1);
    expect(_trackedAuctions.get(4).phase).toBe(PHASES.REVEAL);

    engine._getLedgerSequence = async () => 120;
    transitions = await engine.tick();
    expect(transitions).toHaveLength(1);
    expect(transitions[0].transition).toBe("settle_auction");
    expect(_trackedAuctions.get(4).phase).toBe(PHASES.SETTLED);

    // Settled auctions are never re-evaluated.
    expect(await engine.tick()).toEqual([]);
  });

  it("tickFor evaluates only the requested auction", async () => {
    const engine = freshEngine(110);
    engine.track(10, { phase: "Commit", openLedger: 100, durationLedgers: 10, revealEnd: null });
    engine.track(11, { phase: "Commit", openLedger: 1000, durationLedgers: 10, revealEnd: null });

    const result = await engine.tickFor(10);
    expect(result.transition).toBe("begin_reveal");
    // The untouched auction stays in Commit.
    expect(_trackedAuctions.get(11).phase).toBe(PHASES.COMMIT);

    const missing = await engine.tickFor(999);
    expect(missing.skipped).toBe("not-tracked");
  });

  it("untrack stops evaluating an auction", async () => {
    const engine = freshEngine(110);
    engine.track(12, { phase: "Commit", openLedger: 100, durationLedgers: 10, revealEnd: null });
    engine.untrack(12);
    expect(await engine.tick()).toEqual([]);
  });

  it("broadcasts REVEAL_OPENED and SETTLED events to SSE clients", async () => {
    const events = [];
    const fakeClient = { write: (chunk) => events.push(chunk) };
    _sseClients.add(fakeClient);

    const engine = freshEngine(110);
    engine.track(20, { phase: "Commit", openLedger: 100, durationLedgers: 10, revealEnd: null });
    await engine.tick();

    expect(events.some((e) => e.startsWith("event: REVEAL_OPENED"))).toBe(true);
    expect(events.some((e) => e.includes('"phase":"Reveal"'))).toBe(true);

    engine._getLedgerSequence = async () => 120;
    await engine.tick();

    expect(events.some((e) => e.startsWith("event: SETTLED"))).toBe(true);
    _sseClients.delete(fakeClient);
  });

  it("broadcast drops dead SSE clients", async () => {
    const dead = { write: () => { throw new Error("socket closed"); } };
    const alive = { write: (chunk) => chunk };
    _sseClients.add(dead);
    _sseClients.add(alive);

    broadcast("TEST_EVENT", { ok: true });
    expect(_sseClients.has(dead)).toBe(false);
    expect(_sseClients.has(alive)).toBe(true);
  });
});