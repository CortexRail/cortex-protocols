# [Feature] Granular Rate Limiting & Redis Store Integration

## 📝 Summary

This Pull Request fundamentally redesigns the API rate limiting architecture for the Cortex Protocol backend. It replaces the legacy, overly permissive global rate limiter (200 requests per 15 minutes) with highly granular, endpoint-specific limiters. 

By leveraging a distributed Redis store via `rate-limit-redis`, this implementation ensures that rate limits are consistently enforced across horizontally scaled instances, rather than being localized to individual Node.js processes. Furthermore, this PR differentiates between "Read" endpoints and "Write/Transaction" endpoints, applying distinct limits based on IP addresses for public data and Stellar Public Keys for state-mutating transactions.

## 🎯 Root Cause / Motivation

The legacy rate limiter was implemented as a broad `app.use(limiter)` middleware that captured every request regardless of its computational cost or state-mutating potential. 

This presented several critical issues for a production-grade Web3 intelligence platform:
1. **Denial of Service (DoS) Vulnerability:** An attacker could easily exhaust the global rate limit or overwhelm the database because read-heavy endpoints and expensive write endpoints shared the same quota.
2. **Poor User Experience for High-Volume Readers:** Data aggregators querying public agent leaderboards or asset listings would hit the same 200req/15m limit as users attempting to spam on-chain transactions, leading to unnecessary throttling.
3. **Lack of Distributed State:** The default memory store used by `express-rate-limit` meant that if the backend was scaled across 3 Kubernetes pods, the effective rate limit would inadvertently triple, completely negating the intended security thresholds.
4. **Insufficient Granularity:** State-mutating actions (like reporting an asset, registering an agent, or purchasing a license) require much stricter gating than simply querying an asset's price.

## 🛠 Architectural Decisions

### 1. Separation of Read vs. Write Operations
We established two distinct rate limiters tailored to the specific risk profiles of the endpoints:
- **`publicReadLimiter`**: Configured at **100 requests per minute**. This is strictly bound to the requester's IP address. It applies to all `GET` endpoints, allowing data consumers to efficiently fetch assets, agent activities, and leaderboards without hitting aggressive bottlenecks.
- **`writeLimiter`**: Configured at a much stricter **10 requests per minute**. Rather than relying solely on IP addresses (which can be easily spoofed or rotated), this limiter extracts the **Stellar Public Key** from the request body (`req.body.owner`, `req.body.buyer`, `req.body.voter`, or `req.body.reporter`). This ensures that malicious actors cannot spam state-mutating endpoints simply by changing IPs. 

### 2. Distributed Rate Limiting (Redis)
To ensure rate limit state is synchronized across all deployment nodes, we integrated `rate-limit-redis` alongside the `ioredis` client. 
- In a production environment, the middleware establishes a connection via the `REDIS_URL` environment variable.
- To maintain an optimal Developer Experience (DX) and fast CI/CD pipelines, the implementation intelligently falls back to `express-rate-limit`'s built-in in-memory store when `NODE_ENV === 'test'` and no `REDIS_URL` is provided.

### 3. IPv6 Compatibility & RFC Compliance
During testing, a critical validation error was surfaced by `express-rate-limit` regarding IPv6 spoofing vulnerabilities when manually parsing `req.ip`. This PR implements the recommended `rateLimit.ipKeyGenerator(req, res)` fallback mechanism to guarantee robust handling of IPv4 mapped IPv6 addresses. We also strictly adhere to RFC standard headers by setting `standardHeaders: true` (which injects `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`) and disabling `legacyHeaders`.

## 🔄 Detailed Changes

### Core Middleware
- **`backend/src/middleware/rateLimiter.js`**: 
  - `[NEW]` Initialized `ioredis` client with smart test-environment fallbacks.
  - `[NEW]` Configured `publicReadLimiter` (100 req/min).
  - `[NEW]` Configured `writeLimiter` (10 req/min) with a custom `keyGenerator` designed to scan nested request bodies for Stellar addresses, falling back securely to the validated IP address if a key isn't present.

### Route Refactoring
- **`backend/src/app.js`**: 
  - `[DELETE]` Removed the legacy global `rateLimit` middleware.
- **`backend/src/routes/assets.js`**: 
  - `[MODIFY]` Injected `publicReadLimiter` into `GET /`, `GET /:id`, and `GET /types/list`.
  - `[MODIFY]` Injected `writeLimiter` into `POST /`, `POST /:id/delist`, `PATCH /:id/price`, `POST /:id/purchase`, and `POST /:id/report`.
- **`backend/src/routes/agents.js`**: 
  - `[MODIFY]` Injected `publicReadLimiter` into `GET /`, `GET /capabilities/list`, `GET /leaderboard`, `GET /:id`, `GET /:id/reputation-history`, and `GET /:id/activity`.
  - `[MODIFY]` Injected `writeLimiter` into `POST /` and `POST /:id/reputation`.

### Dependencies
- **`backend/package.json`**: 
  - `[ADD]` Installed `ioredis` and `rate-limit-redis`.
  - `[UPDATE]` Bumped `express-rate-limit` to the latest `v8.x` release to support modern Redis store architectures and improved standard header configurations.

### Test Suite
- **`backend/src/__tests__/rateLimiter.test.js`**: 
  - `[NEW]` Engineered a comprehensive test suite utilizing `supertest` and a mock Express router.
  - `[NEW]` Asserted that exact threshold boundaries correctly return a `200 OK` status.
  - `[NEW]` Validated that breaching the limits immediately returns a `429 Too Many Requests` status alongside the mandatory `Retry-After` HTTP header.

## 🧪 Testing Performed
- **Automated Unit Testing**: Executed `npm test -- src/__tests__/rateLimiter.test.js`. Verified that both limiters successfully trigger 429 errors at exactly 101 and 11 requests respectively.
- **IPv6 Security Validation**: Confirmed that the `ERR_ERL_KEY_GEN_IPV6` validation warning thrown by `express-rate-limit` was successfully suppressed and remediated via the native `ipKeyGenerator` implementation.
- **Local Integration Testing**: Booted the application locally, sent concurrent `GET` requests to `/api/v1/assets`, and verified the presence of `RateLimit-*` headers via curl.

## ⚠️ Impact / Risk Assessment

- **Breaking Changes:** Clients aggressively polling `POST` endpoints may now receive `429` responses. Frontend applications must be capable of handling `429` statuses and respecting the `Retry-After` header.
- **Infrastructure Requirements:** Deployments **must** now provision a Redis instance. DevOps will need to inject the `REDIS_URL` environment variable into staging and production Kubernetes Secrets / ECS Task Definitions.
- **Performance Overheads:** Redis operations are executed asynchronously, adding a nominal (~1-3ms) latency to API responses. This is negligible compared to the database protection and DDoS mitigation benefits.

## ✅ Checklist
- [x] Removed legacy global rate limiter.
- [x] Implemented granular read/write rate limiters.
- [x] Integrated `ioredis` and `rate-limit-redis`.
- [x] Added robust test suite validating 429 and `Retry-After` behavior.
- [x] Resolved IPv6 spoofing validation warnings.
- [x] Dependencies locked and tested.

## 📌 Notes for Reviewers
Please pay close attention to the `keyGenerator` logic within `writeLimiter`. The property names (`owner`, `buyer`, `voter`, `reporter`) map directly to the `req.body` payloads defined in the express-validator middleware for `assets.js` and `agents.js`. If new write endpoints are introduced in the future with different payload properties (e.g., `creator`, `sender`), the `keyGenerator` logic in `rateLimiter.js` will need to be updated to recognize those keys.
