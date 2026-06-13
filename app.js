import express from "express";
import cors from "cors";
import path from "path";
import authRoutes from "./src/modules/auth/auth.routes.js";
import userRoutes from "./src/modules/user/user.routes.js";
import categoryRoutes from "./src/modules/category/category.routes.js";
import courseRoutes from "./src/modules/course/course.routes.js";
import curriculumRoutes from "./src/modules/curriculum/curriculum.routes.js";
import cartRoutes from "./src/modules/cart/cart.routes.js";
import checkoutRoutes from "./src/modules/checkout/checkout.routes.js";
import orderRoutes from "./src/modules/order/order.routes.js";
import enrollmentRoutes from "./src/modules/enrollment/enrollment.routes.js";
import reviewRoutes from "./src/modules/review/review.routes.js";
import progressRoutes from "./src/modules/progress/progress.routes.js";
import notificationRoutes from "./src/modules/notification/notification.routes.js";
import payoutRoutes from "./src/modules/payout/payout.routes.js";
import adminRoutes from "./src/modules/admin/admin.routes.js";
import wishlistRoutes from "./src/modules/wishlist/wishlist.routes.js";
import certificationRoutes from "./src/modules/certification/certification.routes.js";
import legacyRoutes from "./src/modules/legacy/legacy.routes.js";
import {
  cacheGetResponse,
  cacheInvalidationOnMutation,
} from "./src/shared/middleware/cache.middleware.js";
import { createRateLimiter } from "./src/shared/middleware/rate-limit.middleware.js";
import { errorHandler, notFound } from "./src/shared/middleware/error.middleware.js";
import { env } from "./src/shared/config/env.js";
import { prisma } from "./src/shared/database/prisma.js";

const app = express();
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cacheInvalidationOnMutation());
app.use(
  "/api",
  createRateLimiter({
    keyPrefix: "rl:api",
    windowSeconds: 60,
    maxRequests: 240,
    by: "ip",
    message: "Too many API requests. Please try again in a minute.",
  }),
);
app.use("/uploads", express.static(path.resolve(env.uploadDir)));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/curriculum", curriculumRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/enrollments", enrollmentRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/progress", progressRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/payouts", payoutRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/certifications", certificationRoutes);
app.use("/api", legacyRoutes);
app.get(
  "/api/course-price-tiers",
  cacheGetResponse({
    prefix: "course-price-tiers",
    ttlSeconds: 600,
    tags: ["course-price-tiers"],
  }),
  async (_req, res, next) => {
  try {
    const tiers = await prisma.coursePriceTier.findMany({
      orderBy: { price: "asc" },
    });
    return res.json(
      tiers.map((tier) => ({
        id: tier.id,
        title: tier.title,
        price: String(tier.price),
      })),
    );
  } catch (error) {
    return next(error);
  }
},
);

app.get(
  "/api/course-levels",
  cacheGetResponse({
    prefix: "course-levels",
    ttlSeconds: 600,
    tags: ["course-levels"],
  }),
  async (_req, res, next) => {
  try {
    const levels = await prisma.courseLevel.findMany({
      orderBy: [{ weight: "asc" }, { createdAt: "asc" }],
    });
    return res.json(
      levels.map((level) => ({
        id: level.id,
        title: level.title,
        weight: level.weight,
      })),
    );
  } catch (error) {
    return next(error);
  }
},
);

app.use(notFound);
app.use(errorHandler);

export default app;
