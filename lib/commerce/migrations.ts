/** Flatten retired factors once; recorded amounts and ledger entries remain immutable. */
export function retirePricingFactors(
  table: string,
  column: string,
  path = "$",
) {
  const read = (key: string) =>
    `COALESCE(json_extract(${column},'${path}.${key}'),1)`;
  return `UPDATE ${table} SET ${column}=json_remove(
    json_set(${column},'${path}.multiplier',${read("multiplier")}*${read("groupMultiplier")}*${read("userMultiplier")}),
    '${path}.groupMultiplier','${path}.userMultiplier')
    WHERE ${column} IS NOT NULL AND (json_type(${column},'${path}.groupMultiplier') IS NOT NULL OR json_type(${column},'${path}.userMultiplier') IS NOT NULL);`;
}
