import { it, expect } from "vitest";
import { clientAddress } from "../plugins/listener/proxy.js";
it("ignores forged forwarding headers unless the direct peer is trusted", () => {
  expect(clientAddress([])("::ffff:127.0.0.1", "203.0.113.2")).toBe(
    "127.0.0.1",
  );
  expect(clientAddress(["10.0.0.0/8"])("192.0.2.1", "203.0.113.2")).toBe(
    "192.0.2.1",
  );
});
it("walks proxy chains from the right and stops at the first untrusted hop", () => {
  const resolve = clientAddress(["10.0.0.0/8", "2001:db8:abcd::/48"]);
  expect(resolve("10.0.0.1", "1.1.1.1, 203.0.113.9, 10.1.1.1")).toBe(
    "203.0.113.9",
  );
  expect(resolve("2001:db8:abcd::1", "2001:db8:1111::2")).toBe(
    "2001:db8:1111::2",
  );
  expect(resolve("10.0.0.1", "malformed, 203.0.113.1")).toBe("10.0.0.1");
  expect(() => clientAddress(["0.0.0.0/33"])).toThrow();
});
