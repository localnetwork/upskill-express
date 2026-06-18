# Anti-DDoS Protection for API Endpoints (Design)

## Objective
Protect all backend API endpoints under `/api/*` using the `ddos` package (`^0.2.1`) with a strict per-IP threshold of 10 requests/second, while returning safe JSON 429 responses and keeping the process running.

## Scope
- In scope:
  - Integrate `ddos` middleware at application level for all `/api/*` routes.
  - Implement a dedicated wrapper middleware in `src/shared/middleware/ddos.middleware.js`.
  - Make thresholds configurable through environment variables.
  - Keep current Redis-based rate limiter active as a separate control layer.
- Out of scope:
  - Replacing existing Redis limiter.
  - Per-route custom anti-DDoS policies.
  - Infrastructure-level mitigation (WAF/CDN rules).

## Approach
Use Option 2 (selected): a reusable wrapper middleware module around `ddos`.

### Why this approach
- Keeps `app.js` clean and consistent with existing middleware organization.
- Centralizes anti-DDoS defaults and response behavior.
- Makes future tuning easier without touching route wiring repeatedly.

## Architecture Changes

### 1) New middleware module
Create `src/shared/middleware/ddos.middleware.js` that:
- Imports and configures `ddos`.
- Sets defaults:
  - per-IP burst/limit equivalent to 10 requests/second.
  - queue/maximum control values based on package support and safe defaults.
- Forces controlled block behavior:
  - returns `HTTP 429` with JSON body:
    - `message`: human-readable limit message
    - `retryAfter`: numeric hint in seconds when available
- Avoids kill-style behavior and never terminates the node process.

### 2) App wiring
In `app.js`:
- Import the new `createDdosProtection` (or equivalent exported middleware).
- Mount it on `/api` before route modules:
  - `app.use("/api", ddosProtectionMiddleware);`
- Preserve existing middleware order where practical:
  - CORS/body parsers/cache invalidation remain.
  - Anti-DDoS executes before module routers.
  - Existing Redis limiter remains active.

### 3) Config surface
Add environment-backed settings via existing env config pattern (`src/shared/config/env.js`), for example:
- `DDOS_MAX_REQUESTS_PER_SEC` (default `10`)
- optional `DDOS_CHECK_INTERVAL_MS` / package-specific knobs if required by implementation.

Document variables in backend `README.md`.

## Request Flow (target)
1. Client calls `/api/...`
2. DDoS middleware evaluates request frequency by IP.
3. If under threshold: continue to Redis limiter and route handler.
4. If over threshold: immediate `429` JSON response.
5. App process remains healthy and continues serving other requests.

## Error Handling & Reliability
- No broad silent catches that hide failures.
- If middleware initialization fails at startup, fail clearly during boot rather than serving unprotected endpoints unintentionally.
- Runtime block path is explicit and deterministic (429 JSON), not a crash path.

## Compatibility
- Works with current Express app and existing `/api` route structure.
- Does not change route contracts except rate-limit behavior under abuse.

## Validation Plan
- Start API with existing command (`npm run dev`).
- Confirm app boots with middleware loaded.
- Verify `/health` remains unaffected.
- Verify `/api/*` endpoints are reachable under normal load.
- Confirm over-limit traffic receives 429 JSON and process stays up.

## Risks and Mitigations
- **Risk:** overly strict threshold for legitimate burst traffic.
  - **Mitigation:** env-configurable values for quick tuning.
- **Risk:** duplicate limiting with existing Redis limiter can increase 429 frequency.
  - **Mitigation:** keep layers intentionally; tune ddos threshold as frontline guard.

## Success Criteria
- All `/api/*` endpoints pass through `ddos` middleware.
- Threshold set to 10 req/sec per IP by default.
- Abusive traffic receives JSON 429 responses.
- Node process does not terminate due to ddos blocking behavior.
- Existing endpoint behavior remains unchanged for normal traffic.
