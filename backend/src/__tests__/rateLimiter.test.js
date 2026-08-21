const express = require("express");
const request = require("supertest");
const { publicReadLimiter, writeLimiter } = require("../middleware/rateLimiter");

describe("Rate Limiter Middleware", () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Create a mock router to apply limiters
    app.get("/read", publicReadLimiter, (req, res) => {
      res.json({ success: true });
    });

    app.post("/write", writeLimiter, (req, res) => {
      res.json({ success: true });
    });
  });

  describe("publicReadLimiter", () => {
    it("should allow up to 100 requests per minute and then return 429 with Retry-After header", async () => {
      // Send 100 requests, all should pass
      for (let i = 0; i < 100; i++) {
        const res = await request(app).get("/read");
        expect(res.status).toBe(200);
      }

      // The 101st request should be rate-limited
      const res = await request(app).get("/read");
      expect(res.status).toBe(429);
      expect(res.text).toMatch(/Too many requests/i);
      expect(res.headers["retry-after"]).toBeDefined();
    });
  });

  describe("writeLimiter", () => {
    it("should allow up to 10 requests per minute per Stellar address and then return 429 with Retry-After header", async () => {
      const stellarAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

      // Send 10 requests, all should pass
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post("/write")
          .send({ owner: stellarAddress });
        expect(res.status).toBe(200);
      }

      // The 11th request for the same address should be rate-limited
      const res11 = await request(app)
        .post("/write")
        .send({ owner: stellarAddress });
      expect(res11.status).toBe(429);
      expect(res11.headers["retry-after"]).toBeDefined();

      // Another address should still be allowed (independent limit)
      const anotherAddress = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
      const resOther = await request(app)
        .post("/write")
        .send({ owner: anotherAddress });
      expect(resOther.status).toBe(200);
    });
  });
});
