# Anti-DDoS API Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ddos@^0.2.1` protection to all `/api/*` endpoints with a default 10 req/sec per-IP threshold and safe 429 JSON blocking behavior.

**Architecture:** Implement a dedicated middleware wrapper at `src/shared/middleware/ddos.middleware.js` that configures `ddos` and normalizes abusive traffic responses. Wire the wrapper once at the `/api` mount in `app.js` before route handlers. Keep the existing Redis rate limiter active as a second layer.

**Tech Stack:** Node.js (ESM), Express 5, ddos (`^0.2.1`), existing Redis rate limiter middleware, npm.

## Global Constraints

- Use `ddos` package version `^0.2.1`.
- Protect all backend API endpoints under `/api/*`.
- Default anti-DDoS threshold is 10 requests/second per IP.
- Blocked requests must return HTTP 429 JSON (not kill process behavior).
- Existing Redis-based limiter must remain active as a separate layer.
- Configure threshold values through environment configuration and document them.

---

### Task 1: Add dependency and configuration surface

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `src/shared/config/env.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `env` export from `src/shared/config/env.js`
- Produces:
  - `env.ddosMaxRequestsPerSec: number`
  - `env.ddosCheckIntervalMs: number`

- [ ] **Step 1: Write the failing dependency check**

```bash
npm ls ddos
```

Expected: command exits non-zero with output indicating `ddos` is missing.

- [ ] **Step 2: Add the package**

```bash
npm install ddos@^0.2.1
```

Expected: install completes and `package.json` / lockfile include `ddos`.

- [ ] **Step 3: Add env keys in `.env.example`**

```env
DDOS_MAX_REQUESTS_PER_SEC=10
DDOS_CHECK_INTERVAL_MS=1000
```

- [ ] **Step 4: Extend `env` config in `src/shared/config/env.js`**

```js
ddosMaxRequestsPerSec: Number(process.env.DDOS_MAX_REQUESTS_PER_SEC || 10),
ddosCheckIntervalMs: Number(process.env.DDOS_CHECK_INTERVAL_MS || 1000),
```

- [ ] **Step 5: Document new variables in `README.md` environment table**

```md
| `DDOS_MAX_REQUESTS_PER_SEC` | `10` |
| `DDOS_CHECK_INTERVAL_MS` | `1000` |
```

- [ ] **Step 6: Run a config smoke check**

```bash
node -e "import('./src/shared/config/env.js').then(({env})=>console.log(env.ddosMaxRequestsPerSec, env.ddosCheckIntervalMs))"
```

Expected: prints `10 1000` (or current env overrides).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example src/shared/config/env.js README.md
git commit -m "chore: add ddos dependency and env config"
```

### Task 2: Build dedicated anti-DDoS middleware wrapper

**Files:**
- Create: `src/shared/middleware/ddos.middleware.js`

**Interfaces:**
- Consumes:
  - `env.ddosMaxRequestsPerSec: number`
  - `env.ddosCheckIntervalMs: number`
- Produces:
  - `createDdosProtection(): import('express').RequestHandler`

- [ ] **Step 1: Write the failing middleware import check**

```bash
node -e "import('./src/shared/middleware/ddos.middleware.js')"
```

Expected: fails with module not found before file creation.

- [ ] **Step 2: Create `src/shared/middleware/ddos.middleware.js` with minimal implementation**

```js
import DDOS from "ddos";
import { env } from "../config/env.js";

export function createDdosProtection() {
  const ddos = new DDOS({
    burst: env.ddosMaxRequestsPerSec,
    limit: env.ddosMaxRequestsPerSec,
    checkinterval: env.ddosCheckIntervalMs,
  });

  return function ddosProtection(req, res, next) {
    return ddos.express(req, res, (error) => {
      if (error) {
        return res.status(429).json({
          message: "Too many requests. Please try again shortly.",
        });
      }
      return next();
    });
  };
}
```

- [ ] **Step 3: Run middleware import check again**

```bash
node -e "import('./src/shared/middleware/ddos.middleware.js').then((m)=>console.log(typeof m.createDdosProtection))"
```

Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add src/shared/middleware/ddos.middleware.js
git commit -m "feat: add reusable ddos middleware wrapper"
```

### Task 3: Wire middleware globally for `/api` routes

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: `createDdosProtection(): RequestHandler`
- Produces: global `/api` anti-DDoS protection mounted before route handlers

- [ ] **Step 1: Write the failing wiring check**

```bash
node -e "import('node:fs').then(fs=>{const s=fs.readFileSync('app.js','utf8');console.log(s.includes('createDdosProtection'))})"
```

Expected: prints `false` before wiring.

- [ ] **Step 2: Update `app.js` imports and middleware registration**

```js
import { createDdosProtection } from "./src/shared/middleware/ddos.middleware.js";

const ddosProtection = createDdosProtection();
app.use("/api", ddosProtection);
```

Placement rule: mount before all `/api/...` route modules.

- [ ] **Step 3: Run wiring check again**

```bash
node -e "import('node:fs').then(fs=>{const s=fs.readFileSync('app.js','utf8');console.log(s.includes('createDdosProtection') && s.includes('app.use(\"/api\", ddosProtection)'))})"
```

Expected: prints `true`.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: apply ddos protection to api mount"
```

### Task 4: Validate runtime behavior (normal + blocked traffic)

**Files:**
- Modify (if needed): `src/shared/middleware/ddos.middleware.js`
- Modify (if needed): `README.md`

**Interfaces:**
- Consumes: running server (`npm run dev` or `npm start`)
- Produces: confirmed 429 JSON behavior while process stays healthy

- [ ] **Step 1: Start API**

```bash
npm run dev
```

Expected: server starts and logs `Server running on port ...`.

- [ ] **Step 2: Verify baseline health endpoint**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/health
```

Expected: `200`.

- [ ] **Step 3: Trigger burst traffic against one `/api` endpoint**

```bash
for i in {1..20}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/course-levels; done
```

Expected: early requests return `200`; over-limit requests return `429`.

- [ ] **Step 4: Confirm blocked response body is JSON**

```bash
curl -s http://localhost:4000/api/course-levels
```

Expected when blocked: JSON payload with `message` field.

- [ ] **Step 5: Confirm process remains alive**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/health
```

Expected: still `200` after rate-limit blocks.

- [ ] **Step 6: Final docs touch-up (only if behavior differs)**

If implementation output text differs from plan wording, update `README.md` to match final response shape.

- [ ] **Step 7: Commit**

```bash
git add src/shared/middleware/ddos.middleware.js README.md
git commit -m "test: validate ddos runtime behavior and finalize docs"
```

## Self-Review Notes

- Spec coverage: every requirement from the approved design maps to tasks above (dependency, wrapper module, `/api` mount, env config, docs, runtime validation).
- Placeholder scan: no TODO/TBD placeholders remain.
- Interface consistency: `createDdosProtection()` and `env.ddosMaxRequestsPerSec`/`env.ddosCheckIntervalMs` are defined once and used consistently across tasks.
