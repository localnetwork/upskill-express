import { prisma } from "../../shared/database/prisma.js";

export async function calculateTax({ taxRegionCode, taxableAmount }) {
  if (!taxRegionCode) {
    return {
      region: null,
      taxAmount: 0,
      breakdown: [],
    };
  }

  const region = await prisma.taxRegion.findFirst({
    where: { code: taxRegionCode, isActive: true },
    include: {
      rates: {
        where: {
          isActive: true,
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: new Date() } }],
          AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }] }],
        },
      },
    },
  });

  if (!region) {
    return {
      region: null,
      taxAmount: 0,
      breakdown: [],
    };
  }

  const breakdown = region.rates.map((rate) => {
    const tax = (Number(taxableAmount) * Number(rate.ratePercent)) / 100;
    return {
      taxType: rate.taxType,
      ratePercent: Number(rate.ratePercent),
      taxAmount: Number(tax.toFixed(2)),
    };
  });

  const taxAmount = breakdown.reduce((sum, item) => sum + item.taxAmount, 0);

  return {
    region,
    taxAmount: Number(taxAmount.toFixed(2)),
    breakdown,
  };
}
