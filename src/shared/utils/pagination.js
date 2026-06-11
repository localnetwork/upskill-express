function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

export function getPagination(query = {}) {
  const source = query && typeof query === "object" ? query : {};
  const nested = source.pagination && typeof source.pagination === "object" ? source.pagination : {};

  const rawPage = source.page ?? nested.page ?? 1;
  const rawLimit = source.limit ?? source.per_page ?? nested.limit ?? nested.per_page ?? 10;

  const page = Math.max(toPositiveInt(rawPage, 1), 1);
  const limit = Math.min(Math.max(toPositiveInt(rawLimit, 10), 1), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function toPagedResult(data, total, page, limit) {
  const safeLimit = Math.max(toPositiveInt(limit, 10), 1);
  const safeTotal = Math.max(toPositiveInt(total, 0), 0);
  const totalPages = Math.ceil(safeTotal / safeLimit);

  return {
    data,
    meta: {
      total: safeTotal,
      page,
      limit: safeLimit,
      totalPages,
    },
    // Backward compatibility for handlers expecting `pagination`
    pagination: {
      total: safeTotal,
      page,
      limit: safeLimit,
      totalPages,
    },
  };
}
