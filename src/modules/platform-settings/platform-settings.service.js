import { prisma } from "../../shared/database/prisma.js";

export const PAYOUT_CYCLES = ["ANYTIME", "DAILY", "WEEKLY", "MONTHLY"];

const SETTINGS = {
  platformFeePercent: {
    key: "PLATFORM_FEE_PERCENT",
    defaultValue: 20,
    description: "Platform fee percentage applied to each paid order item",
  },
  taxPercent: {
    key: "TAX_PERCENT",
    defaultValue: 0,
    description: "Global tax percentage applied during checkout",
  },
  payoutCycle: {
    key: "PAYOUT_CYCLE",
    defaultValue: "ANYTIME",
    description: "Payout cycle availability for educator cashout requests",
  },
  defaultCurrency: {
    key: "DEFAULT_CURRENCY",
    defaultValue: "PHP",
    description: "Default currency used for checkout and payout records",
  },
};

function toPercent(value, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(Math.max(Number(normalized.toFixed(2)), 0), 100);
}

function toPayoutCycle(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return PAYOUT_CYCLES.includes(normalized) ? normalized : fallback;
}

function toCurrency(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function mapSettings(rows = []) {
  const values = new Map(rows.map((row) => [row.key, row.value]));

  return {
    platformFeePercent: toPercent(
      values.get(SETTINGS.platformFeePercent.key),
      SETTINGS.platformFeePercent.defaultValue,
    ),
    taxPercent: toPercent(
      values.get(SETTINGS.taxPercent.key),
      SETTINGS.taxPercent.defaultValue,
    ),
    payoutCycle: toPayoutCycle(
      values.get(SETTINGS.payoutCycle.key),
      SETTINGS.payoutCycle.defaultValue,
    ),
    defaultCurrency: toCurrency(
      values.get(SETTINGS.defaultCurrency.key),
      SETTINGS.defaultCurrency.defaultValue,
    ),
  };
}

export async function getPlatformCommerceSettings() {
  const rows = await prisma.platformSetting.findMany({
    where: {
      key: {
        in: Object.values(SETTINGS).map((item) => item.key),
      },
    },
    select: {
      key: true,
      value: true,
    },
  });
  return mapSettings(rows);
}

export async function updatePlatformCommerceSettings(payload) {
  const current = await getPlatformCommerceSettings();
  const next = {
    platformFeePercent:
      payload.platformFeePercent === undefined
        ? current.platformFeePercent
        : toPercent(payload.platformFeePercent, current.platformFeePercent),
    taxPercent:
      payload.taxPercent === undefined
        ? current.taxPercent
        : toPercent(payload.taxPercent, current.taxPercent),
    payoutCycle:
      payload.payoutCycle === undefined
        ? current.payoutCycle
        : toPayoutCycle(payload.payoutCycle, current.payoutCycle),
    defaultCurrency:
      payload.defaultCurrency === undefined
        ? current.defaultCurrency
        : toCurrency(payload.defaultCurrency, current.defaultCurrency),
  };

  await prisma.$transaction([
    prisma.platformSetting.upsert({
      where: { key: SETTINGS.platformFeePercent.key },
      update: {
        value: String(next.platformFeePercent),
        description: SETTINGS.platformFeePercent.description,
      },
      create: {
        key: SETTINGS.platformFeePercent.key,
        value: String(next.platformFeePercent),
        description: SETTINGS.platformFeePercent.description,
      },
    }),
    prisma.platformSetting.upsert({
      where: { key: SETTINGS.taxPercent.key },
      update: {
        value: String(next.taxPercent),
        description: SETTINGS.taxPercent.description,
      },
      create: {
        key: SETTINGS.taxPercent.key,
        value: String(next.taxPercent),
        description: SETTINGS.taxPercent.description,
      },
    }),
    prisma.platformSetting.upsert({
      where: { key: SETTINGS.payoutCycle.key },
      update: {
        value: next.payoutCycle,
        description: SETTINGS.payoutCycle.description,
      },
      create: {
        key: SETTINGS.payoutCycle.key,
        value: next.payoutCycle,
        description: SETTINGS.payoutCycle.description,
      },
    }),
    prisma.platformSetting.upsert({
      where: { key: SETTINGS.defaultCurrency.key },
      update: {
        value: next.defaultCurrency,
        description: SETTINGS.defaultCurrency.description,
      },
      create: {
        key: SETTINGS.defaultCurrency.key,
        value: next.defaultCurrency,
        description: SETTINGS.defaultCurrency.description,
      },
    }),
  ]);

  return next;
}
