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
  trialEnabled: {
    key: "TRIAL_ENABLED",
    defaultValue: true,
    description: "Give newly verified learners a free trial",
  },
  trialDays: {
    key: "TRIAL_DAYS",
    defaultValue: 7,
    description: "Length of the learner free trial in days",
  },
  trialMaxCoursesPerLearner: {
    key: "TRIAL_MAX_COURSES",
    defaultValue: 3,
    description: "Max Trial Pool courses a learner can open during the trial",
  },
  trialPoolMaxPercent: {
    key: "TRIAL_POOL_MAX_PERCENT",
    defaultValue: 20,
    description: "Max share of published courses that can be in the Trial Pool",
  },
  trialConversionBonus: {
    key: "TRIAL_CONVERSION_BONUS",
    defaultValue: 50,
    description: "Bonus paid to an educator when a trial learner buys their course",
  },
  trialConversionWindowDays: {
    key: "TRIAL_CONVERSION_WINDOW_DAYS",
    defaultValue: 30,
    description: "Days after trial access in which a purchase counts as a conversion",
  },
  subscriptionPoolPercent: {
    key: "SUBSCRIPTION_POOL_PERCENT",
    defaultValue: 45,
    description: "Share of net subscription revenue distributed to educators by watch time",
  },
};

const NUMERIC_SETTING_KEYS = {
  trialDays: { min: 1, max: 60, integer: true },
  trialMaxCoursesPerLearner: { min: 1, max: 50, integer: true },
  trialPoolMaxPercent: { min: 0, max: 100 },
  trialConversionBonus: { min: 0, max: 100000 },
  trialConversionWindowDays: { min: 1, max: 365, integer: true },
  subscriptionPoolPercent: { min: 0, max: 100 },
};

function toBoundedNumber(value, fallback, { min, max, integer }) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return fallback;
  const bounded = Math.min(Math.max(normalized, min), max);
  return integer ? Math.round(bounded) : Number(bounded.toFixed(2));
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === "true";
}

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
    trialEnabled: toBoolean(
      values.get(SETTINGS.trialEnabled.key),
      SETTINGS.trialEnabled.defaultValue,
    ),
    ...Object.fromEntries(
      Object.entries(NUMERIC_SETTING_KEYS).map(([name, rules]) => [
        name,
        toBoundedNumber(
          values.get(SETTINGS[name].key),
          SETTINGS[name].defaultValue,
          rules,
        ),
      ]),
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
    trialEnabled: toBoolean(payload.trialEnabled, current.trialEnabled),
    ...Object.fromEntries(
      Object.entries(NUMERIC_SETTING_KEYS).map(([name, rules]) => [
        name,
        payload[name] === undefined
          ? current[name]
          : toBoundedNumber(payload[name], current[name], rules),
      ]),
    ),
  };

  const extraUpserts = ["trialEnabled", ...Object.keys(NUMERIC_SETTING_KEYS)].map(
    (name) =>
      prisma.platformSetting.upsert({
        where: { key: SETTINGS[name].key },
        update: {
          value: String(next[name]),
          description: SETTINGS[name].description,
        },
        create: {
          key: SETTINGS[name].key,
          value: String(next[name]),
          description: SETTINGS[name].description,
        },
      }),
  );

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
    ...extraUpserts,
  ]);

  return next;
}
