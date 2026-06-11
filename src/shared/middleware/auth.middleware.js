import { prisma } from "../database/prisma.js";
import { ApiError } from "../utils/ApiError.js";
import { verifyAccessToken } from "../utils/jwt.js";

async function resolveAuthUser(header) {
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  const token = header.replace("Bearer ", "");
  const payload = verifyAccessToken(token);
  const user = await prisma.user.findFirst({
    where: { id: payload.sub, deletedAt: null, isActive: true },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
    },
  });

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    roles: user.roles.map((item) => item.role.name),
  };
}

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new ApiError(401, "Unauthorized"));
  }

  try {
    const authUser = await resolveAuthUser(header);
    if (!authUser) {
      return next(new ApiError(401, "Unauthorized"));
    }
    req.user = authUser;
    return next();
  } catch (_error) {
    return next(new ApiError(401, "Invalid or expired token"));
  }
}

export async function authenticateOptional(req, _res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next();
  }

  try {
    const authUser = await resolveAuthUser(header);
    if (authUser) {
      req.user = authUser;
    }
    return next();
  } catch (_error) {
    return next();
  }
}