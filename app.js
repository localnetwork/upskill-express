import express from "express";
import cors from "cors";
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
import { errorHandler, notFound } from "./src/shared/middleware/error.middleware.js";
import { env } from "./src/shared/config/env.js";

const app = express();
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.use(notFound);
app.use(errorHandler);

export default app;
