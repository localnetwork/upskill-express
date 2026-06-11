import { Prisma } from "@prisma/client";

export function notFound(_req, res) {
  return res.status(404).json({
    message: "Route not found",
  });
}

export function errorHandler(error, _req, res, _next) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return res.status(400).json({
      message: "Database error",
      code: error.code,
    });
  }

  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    message: error.message || "Internal server error",
    details: error.details || undefined,
  });
}
