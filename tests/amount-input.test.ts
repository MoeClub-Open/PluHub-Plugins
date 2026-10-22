import { it, expect } from "vitest";
import { usdToMicros } from "../lib/commerce/decimal.js";
it("converts displayed USD to safe ledger micros exactly and rejects ambiguous or overprecise input", () => {
  expect(usdToMicros("0.000001")).toBe(1);
  expect(usdToMicros("12.340001")).toBe(12340001);
  expect(usdToMicros("-.5")).toBe(-500000);
  expect(usdToMicros("9007199254.740991")).toBe(Number.MAX_SAFE_INTEGER);
  for (const input of ["1e3", "0.0000001", "9007199254.740992", "", "NaN"])
    expect(() => usdToMicros(input)).toThrow();
});
