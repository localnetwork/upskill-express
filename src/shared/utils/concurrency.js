/**
 * Like Promise.all(items.map(fn)) but runs at most `limit` tasks at once, so a
 * single request can't occupy the whole Prisma connection pool.
 */
export async function mapWithConcurrency(items, fn, limit = 4) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await fn(list[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, worker),
  );
  return results;
}
