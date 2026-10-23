import { it, expect } from "vitest";
import { newApiPrices, tokenPrice } from "../lib/ai/channel-pricing.js";
import { isPublicAddress, publicLookup } from "../lib/ai/public-network.js";
it("reads token prices from New API and validates price bounds", () => {
  const prices = newApiPrices({
    data: {
      model_ratio: { m: 1.25, fixed: 2, missing: 2 },
      completion_ratio: { m: 4, fixed: 1 },
      model_price: { fixed: 1 },
    },
  });
  expect(prices).toEqual({ m: { inputPrice: 2.5, outputPrice: 10 } });
  for (const price of [NaN, Infinity, -1, "2", 1e20])
    expect(() => tokenPrice(price)).toThrow();
});
it("denies private, reserved, mapped and transition addresses at the connector including DNS resolution", async () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
  ])
    expect(isPublicAddress(ip), ip).toBe(false);
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    expect(isPublicAddress(ip), ip).toBe(true);
  await expect(
    new Promise((resolve, reject) =>
      publicLookup("localhost", {}, (error: Error | null, address: string) =>
        error ? reject(error) : resolve(address),
      ),
    ),
  ).rejects.toMatchObject({ code: "private_upstream" });
});
