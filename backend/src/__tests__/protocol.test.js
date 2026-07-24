const app = require("../app");
const { Keypair } = require("@stellar/stellar-sdk");

const {
  truncateAll,
  closePool,
  buildAsset,
  OWNER_A,
  OWNER_B,
} = require("./helpers/testDb");

const QuoteManager = require("../protocol/QuoteManager");
const StreamNegotiator = require("../protocol/StreamNegotiator");
const MeteringEngine = require("../protocol/MeteringEngine");
const StreamMonitor = require("../protocol/StreamMonitor");
const BatchSettler = require("../protocol/BatchSettler");
const CortexAgentSDK = require("../sdk/CortexAgentSDK");
const streamRepository = require("../repositories/streamRepository");
const assetRepository = require("../repositories/assetRepository");

let server;
let port;

beforeAll((done) => {
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});

// Setup/Teardown
beforeEach(async () => {
  await truncateAll();
  QuoteManager._pendingQuotes.clear();
  StreamNegotiator._agreedTerms.clear();
  StreamMonitor._sseClients.clear();
});

afterAll(async () => {
  await closePool();
  BatchSettler.stop();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("Agent Payment Protocol - QuoteManager", () => {
  it("generates valid quotes and rejects expired/tampered ones", () => {
    const buyer = OWNER_A;
    const assetId = 42;
    const price = 5000;

    const quote = QuoteManager.generateQuote(buyer, assetId, price);
    expect(quote.buyer).toBe(buyer);
    expect(quote.price).toBe(price);

    // Should validate correctly
    const valid = QuoteManager.validateQuote(quote);
    expect(valid).toBe(true);

    // Re-validation should fail because it was deleted from pending store on success
    const secondValidation = QuoteManager.validateQuote(quote);
    expect(secondValidation).toBe(false);
  });

  it("rejects expired quotes", () => {
    const buyer = OWNER_A;
    const assetId = 42;
    const price = 5000;

    const quote = QuoteManager.generateQuote(buyer, assetId, price);
    // Manually force expiration
    quote.expiresAt = Date.now() - 1000;

    const valid = QuoteManager.validateQuote(quote);
    expect(valid).toBe(false);
  });

  it("rejects quotes with modified price or signatures", () => {
    const buyer = OWNER_A;
    const assetId = 42;
    const price = 5000;

    const quote = QuoteManager.generateQuote(buyer, assetId, price);
    quote.price = 1000; // modified price

    const valid = QuoteManager.validateQuote(quote);
    expect(valid).toBe(false);
  });
});

describe("Agent Payment Protocol - MeteringEngine Concurrency", () => {
  it("is atomic under concurrent requests (race condition test)", async () => {
    const buyer = OWNER_A;
    const recipient = OWNER_B;
    const pricePerCall = 1000;

    // Create a stream row with exactly 5 remaining calls
    const stream = await streamRepository.create({
      id: 12345,
      sender: buyer,
      recipient,
      token: "native",
      deposit: 5000,
      ratePerSecond: 10,
      startTime: Math.floor(Date.now() / 1000),
      endTime: Math.floor(Date.now() / 1000) + 1000,
      status: "Active",
      withdrawn: 0,
      callsRemaining: 5,
      callsUsed: 0,
      pricePerCall,
    });

    const token = StreamNegotiator.issueStreamToken(stream, pricePerCall);

    // Make 10 concurrent requests to MeteringEngine.meterCall
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(MeteringEngine.meterCall(token).catch((err) => err));
    }

    const results = await Promise.all(promises);

    // Exactly 5 should have succeeded and 5 should have failed
    const successes = results.filter((res) => res && res.calls_remaining !== undefined);
    const failures = results.filter((res) => res instanceof Error && (res.status === 402 || res.message.includes("exhausted")));

    expect(successes).toHaveLength(5);
    expect(failures).toHaveLength(5);

    // Verify database state is consistent
    const finalStream = await streamRepository.findById(12345);
    expect(finalStream.callsRemaining).toBe(0);
    expect(finalStream.callsUsed).toBe(5);
  });
});

describe("Agent Payment Protocol - StreamMonitor (SSE alerts)", () => {
  it("fires LOW_BALANCE warning at 10% deposit remaining", () => {
    const mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
    };

    // Register SSE client
    StreamMonitor.registerClient({ on: () => {} }, mockRes);
    expect(StreamMonitor._sseClients.size).toBe(1);

    // Check a stream with 10% remaining calls (e.g. calls_remaining=1, calls_used=9)
    const stream1 = {
      id: 777,
      sender: OWNER_A,
      callsRemaining: 1,
      callsUsed: 9,
    };

    StreamMonitor.checkStreamAndAlert(stream1);
    expect(mockRes.write).toHaveBeenCalled();

    const lastCallArg = mockRes.write.mock.calls[1][0];
    expect(lastCallArg).toContain("LOW_BALANCE");
    expect(lastCallArg).toContain("percentRemaining\":10");
  });

  it("does not fire LOW_BALANCE warning if balance is above 10%", () => {
    const mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
    };

    StreamMonitor.registerClient({ on: () => {} }, mockRes);
    mockRes.write.mockClear();

    // Check stream with 50% remaining calls (e.g. calls_remaining=5, calls_used=5)
    const stream2 = {
      id: 888,
      sender: OWNER_A,
      callsRemaining: 5,
      callsUsed: 5,
    };

    StreamMonitor.checkStreamAndAlert(stream2);
    // Should not call write with LOW_BALANCE
    const calls = mockRes.write.mock.calls.map(c => c[0]);
    const lowBalanceCalls = calls.filter(c => c.includes("LOW_BALANCE"));
    expect(lowBalanceCalls).toHaveLength(0);
  });
});

describe("Agent Payment Protocol - End-to-End SDK Flow", () => {
  it("enables a full programmatic buy-and-use cycle", async () => {
    const buyerKeypair = Keypair.random();
    
    // Seed database with an asset owned by OWNER_B
    const asset = buildAsset({
      id: 100,
      owner: OWNER_B,
      price: 1000,
      licenseType: "UsageBased",
    });
    await assetRepository.create(asset);

    const sdk = new CortexAgentSDK({
      backendUrl: `http://localhost:${port}`,
      buyerKeypair,
    });

    // 1. Discover assets
    const discovery = await sdk.discover({ assetType: "Prompt" });
    expect(discovery.data.length).toBeGreaterThan(0);
    const targetAsset = discovery.data.find((a) => a.id === 100);
    expect(targetAsset).toBeDefined();

    // 2. Open Stream (Handshake + Negotiate + Open + Register)
    // Deposit 10.0 XLM for 1 hour duration.
    const { streamId, streamToken, stream } = await sdk.openStream(100, 10.0, 1);
    expect(streamId).toBeDefined();
    expect(streamToken).toBeDefined();
    expect(stream.pricePerCall).toBe(1000);

    // 3. Make 30 metered calls (above batch size of 25)
    let settleNowFired = false;
    for (let i = 0; i < 30; i++) {
      const response = await sdk.call(streamToken, { query: `request-${i}` });
      expect(response.calls_remaining).toBeDefined();
      if (response.settle_now) {
        settleNowFired = true;
      }
    }

    expect(settleNowFired).toBe(true);

    // 4. BatchSettler triggers withdrawal
    const dbStreamBefore = await streamRepository.findById(streamId);
    expect(dbStreamBefore.callsUsed).toBe(30);

    // Execute the settler logic manually (simulating the cron run)
    await BatchSettler.runSettlement();

    const dbStreamAfter = await streamRepository.findById(streamId);
    // calls_used should be reset to 0 (or decremented by 25/30)
    expect(dbStreamAfter.callsUsed).toBe(0);
    expect(dbStreamAfter.withdrawn).toBeGreaterThan(0);

    // 5. Close Stream
    await sdk.closeStream(streamId);
    const closedStream = await streamRepository.findById(streamId);
    expect(closedStream.status).toBe("Cancelled");
  });
});
