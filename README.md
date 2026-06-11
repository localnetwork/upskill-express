# Upskill Node API

Express + Prisma backend for an LMS-style platform with authentication, courses, checkout, enrollments, reviews, progress tracking, notifications, payouts, and admin moderation.

## Quick start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create/update `.env` (see variables below).
3. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```
4. Run migrations:
   ```bash
   npm run prisma:migrate
   ```
5. Start API:
   ```bash
   npm run dev
   ```

The API runs on `http://localhost:3000` by default.

## Environment variables

| Variable | Default |
| --- | --- |
| `NODE_ENV` | `development` |
| `PORT` | `3000` |
| `CORS_ORIGIN` | `*` |
| `JWT_ACCESS_SECRET` | `access-secret` |
| `JWT_REFRESH_SECRET` | `refresh-secret` |
| `JWT_ACCESS_TTL` | `15m` |
| `JWT_REFRESH_TTL` | `30d` |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_CLIENT_ID` | `""` |
| `PAYPAL_CLIENT_SECRET` | `""` |
| `FRONTEND_URL` | `http://localhost:3000` |
| `UPLOAD_DIR` | `uploads` |

## Scripts

- `npm run dev` - start with nodemon
- `npm start` - start with node
- `npm run prisma:merge` - merge prisma files
- `npm run prisma:generate` - merge + generate client
- `npm run prisma:migrate` - merge + run migration
- `npm run prisma:studio` - open Prisma Studio
- `npm run seed` - run seed script

## API overview

Base URL: `http://localhost:3000`

- `GET /health`
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

Protected routes use:

```http
Authorization: Bearer <access_token>
```

## Postman import

Use the included `postman_collection.json` file:

1. Open Postman
2. Click **Import**
3. Select `postman_collection.json`
4. Set collection variables (`baseUrl`, `accessToken`, IDs/slugs as needed)
