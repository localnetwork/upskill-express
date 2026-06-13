import { prisma } from "../database/prisma.js";
import { ApiError } from "../utils/ApiError.js";
import { verifyAccessToken } from "../utils/jwt.js";

function extractBearerToken(header) {
  if (!header?.startsWith("Bearer ")) return "";
  return String(header.replace("Bearer ", "")).trim();
}

function parseCookieHeader(cookieHeader = "") {
  const cookies = {};
  for (const pair of String(cookieHeader).split(/;\s*/)) {
    if (!pair) continue;
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getCookieTokenCandidates(req) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const candidateNames = Array.from(
    new Set(
      [
        process.env.NEXT_PUBLIC_TOKEN,
        "upskill-token",
        "app_token",
      ].filter(Boolean),
    ),
  );

  return candidateNames
    .map((name) => String(cookies[name] || "").trim())
    .filter(Boolean);
}

async function resolveAuthUserFromToken(token) {
  if (!token) return null;
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

  try {
    const bearerToken = extractBearerToken(header);
    const candidates = [
      ...(bearerToken ? [bearerToken] : []),
      ...getCookieTokenCandidates(req),
    ];

    for (const token of candidates) {
      try {
        const authUser = await resolveAuthUserFromToken(token);
        if (authUser) {
          req.user = authUser;
          return next();
        }
      } catch (_error) {}
    }

    return next(new ApiError(401, "Unauthorized"));
  } catch (_error) {
    return next(new ApiError(401, "Invalid or expired token"));
  }
}

export async function authenticateOptional(req, _res, next) {
  const header = req.headers.authorization;

  try {
    const bearerToken = extractBearerToken(header);
    const candidates = [
      ...(bearerToken ? [bearerToken] : []),
      ...getCookieTokenCandidates(req),
    ];

    for (const token of candidates) {
      try {
        const authUser = await resolveAuthUserFromToken(token);
        if (authUser) {
          req.user = authUser;
          break;
        }
      } catch (_error) {}
    }

    return next();
  } catch (_error) {
    return next();
  }
}