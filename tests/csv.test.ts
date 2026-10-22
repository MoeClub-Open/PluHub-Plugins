import { it, expect } from "vitest";
import { csvCell, csvResponse, exportGuard } from "../lib/export/csv.js";

it("escapes quotes, newlines and spreadsheet formulas without changing numeric values", async () => {
  for (const value of [
    "=cmd()",
    "+SUM(1,1)",
    "-1+2",
    "@SUM(1)",
    "  =1+1",
    "\t=1+1",
    "\r@x",
  ])
    expect(csvCell(value)).toContain("\"'");
  expect(csvCell(-123)).toBe('"-123"');
  expect(csvCell(null)).toBe('""');
  expect(csvCell('say "hello"\nnext')).toBe('"say ""hello""\nnext"');
  const response = csvResponse(
    "test.csv",
    ["source", "amount"],
    [["=formula", -1]],
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain('"\'=formula","-1"');
  expect(() =>
    csvResponse(
      "test.csv",
      [],
      Array.from({ length: 10001 }, () => []),
    ),
  ).toThrow(/10000/);
});
it("bounds export frequency per owner instead of letting another user consume their window", () => {
  const guard = exportGuard();
  guard("a");
  expect(() => guard("a")).toThrow();
  expect(() => guard("b")).not.toThrow();
});
