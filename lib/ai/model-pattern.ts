export function modelPatternMatches(rule: string, model: string) {
  const parts = rule.split("*");
  if (parts.length === 1) return rule === model;
  if (!model.startsWith(parts[0]!)) return false;
  let cursor = parts[0]!.length;
  for (const part of parts.slice(1, -1)) {
    const index = model.indexOf(part, cursor);
    if (index < 0) return false;
    cursor = index + part.length;
  }
  const tail = parts.at(-1)!;
  return model.endsWith(tail) && model.length - tail.length >= cursor;
}
