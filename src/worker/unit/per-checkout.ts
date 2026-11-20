const REJECTED = "rejected";

export async function perCheckout<C, T>(
  checkouts: readonly C[],
  work: (checkout: C, index: number) => Promise<T>,
): Promise<T[]> {
  const settled = await Promise.allSettled(checkouts.map(work));
  const values: T[] = [];
  for (const entry of settled) {
    if (entry.status === REJECTED) throw entry.reason;
    values.push(entry.value);
  }
  return values;
}
