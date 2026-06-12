# Upskill Node API

Express + Prisma backend for an LMS-style platform with auth, courses, checkout, enrollments, reviews, progress, notifications, payouts, wishlist, and admin moderation.

## Table of contents

- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [API overview](#api-overview)
- [Project structure](#project-structure)
- [Postman](#postman)

## Tech stack

- Node.js + Express
- Prisma ORM
- MySQL/PostgreSQL-compatible `DATABASE_URL` (via Prisma)
- JWT authentication
- PayPal integration
- Cloudflare R2 integration (optional)

## Getting started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
   On Windows PowerShell:
   ```powershell
   Copy-Item .env.example .env
   ```
3. Update `.env` values (`DATABASE_URL`, JWT secrets, PayPal keys, and any storage config).
4. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```
5. Run migrations:
   ```bash
   npm run prisma:migrate
   ```
6. Start the API:
   ```bash
   npm run dev
   ```

The server uses `PORT` from `.env` (runtime fallback: `3000`).

## Environment variables

| Variable | Default / Example |
| --- | --- |
| `DATABASE_URL` | `""` (required) |
| `NODE_ENV` | `development` |
| `PORT` | `3000` (runtime fallback) |
| `CORS_ORIGIN` | `*` |
| `JWT_ACCESS_SECRET` | `access-secret` (set a secure value) |
| `JWT_REFRESH_SECRET` | `refresh-secret` (set a secure value) |
| `JWT_ACCESS_TTL` | `15m` |
| `JWT_REFRESH_TTL` | `30d` |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_CLIENT_ID` | `""` |
| `PAYPAL_CLIENT_SECRET` | `""` |
| `FRONTEND_URL` | `http://localhost:3000` |
| `UPLOAD_DIR` | `uploads` |
| `CF_ACCESS_KEY_ID` | `""` |
| `CF_ACCESS_SECRET` | `""` |
| `CF_ENDPOINT` | `""` |
| `CF_BUCKET` | `""` |
| `CF_PUBLIC_ACCESS_URL` | `""` |

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start server with nodemon |
| `npm start` | Start server with node |
| `npm run migrate:uploads:r2` | Upload local `uploads/*` to Cloudflare R2 and update DB paths |
| `npm run prisma:merge` | Merge Prisma schema files |
| `npm run prisma:generate` | Merge schema + generate Prisma client |
| `npm run prisma:migrate` | Merge schema + run Prisma migrations |
| `npm run prisma:studio` | Open Prisma Studio |
| `npm run seed` | Run seed script |

## API overview

Base URL: `http://localhost:<PORT>`

- `GET /health`
- `GET /api/course-price-tiers`
- `GET /api/course-levels`
- Auth: `/api/auth/*`
- Users: `/api/users/*`
- Categories: `/api/categories/*`
- Courses: `/api/courses/*`
- Curriculum: `/api/curriculum/*`
- Cart: `/api/cart/*`
- Checkout: `/api/checkout/*`
- Orders: `/api/orders/*`
- Enrollments: `/api/enrollments/*`
- Reviews: `/api/reviews/*`
- Progress: `/api/progress/*`
- Notifications: `/api/notifications/*`
- Payouts: `/api/payouts/*`
- Admin: `/api/admin/*`
- Wishlist: `/api/wishlist/*`
- Legacy endpoints: `/api/*` (legacy router)

Protected routes use:

```http
Authorization: Bearer <access_token>
```

## Project structure

```text
.
├─ app.js
├─ server.js
├─ prisma/
├─ scripts/
└─ src/
   ├─ modules/
   └─ shared/
```

## Postman

Import `postman_collection.json` into Postman, then set collection variables (`baseUrl`, `accessToken`, IDs/slugs) before running requests.
