/** Allocate the next visible configuration ID without reusing deleted ones. */
export function nextNumericId(ids: Iterable<string>, minimum = "1") {
  let next = /^\d+$/.test(minimum) ? BigInt(minimum) : 1n;
  for (const id of ids)
    if (/^\d+$/.test(id)) {
      const candidate = BigInt(id) + 1n;
      if (candidate > next) next = candidate;
    }
  return String(next);
}
