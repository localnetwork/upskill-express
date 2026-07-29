import app from "./app.js";
import { env } from "./src/shared/config/env.js";
import { createServer } from "http";
import { initSocket } from "./src/shared/realtime/socket.js";
import { startAutoPayoutScheduler, stopAutoPayoutScheduler } from "./src/modules/payout/payout.scheduler.js";
import { prisma } from "./src/shared/database/prisma.js";

const PORT = env.port;
const server = createServer(app);
initSocket(server);

const FORCE_EXIT_TIMEOUT_MS = 10_000;

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[server] Received ${signal}. Starting graceful shutdown...`);

  // Stop scheduled tasks
  stopAutoPayoutScheduler();

  // Force exit after timeout if something hangs
  const forceExitTimer = setTimeout(() => {
    console.error("[server] Forced shutdown after timeout.");
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
  forceExitTimer.unref();

  let hasError = false;

  // 1. Stop accepting new connections and close existing ones
  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    console.log("[server] HTTP server closed.");
  } catch (err) {
    console.error("[server] Error closing HTTP server:", err);
    hasError = true;
  }

  // 2. Destroy keep-alive connections (Node 18.2+)
  try {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  } catch {
    // Silently ignore if unavailable
  }

  // 3. Disconnect database
  try {
    await prisma.$disconnect();
    console.log("[server] Prisma disconnected.");
  } catch (err) {
    console.error("[server] Error disconnecting Prisma:", err);
    hasError = true;
  }

  clearTimeout(forceExitTimer);
  process.exit(hasError ? 1 : 0);
}

// Handle termination signals
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGUSR2", () => shutdown("SIGUSR2"));

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startAutoPayoutScheduler();
});
