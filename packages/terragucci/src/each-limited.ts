/**
 * Run `fn` over `items`, at most `limit` at once, taking them in order. A
 * throw stops new items from starting, waits for the running ones, and is
 * rethrown, so nothing is left running when the caller cleans up.
 *
 * It imports nothing, so a module that report/stage.ts reaches (the
 * migrations) can take it without a cycle.
 */
export async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { e: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        failure ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure.e;
}
