import { it, expect } from "vitest";
import {
  normalizeSubscriptionToken,
  subscriptionKind,
  subscriptionQuota,
} from "../lib/ai/subscription-auth.js";
const now = 1800000000000;
it("imports Codex auth.json and extracts account hints without retaining identity tokens", () => {
  const jwt =
    "x." +
    Buffer.from(
      JSON.stringify({
        exp: now / 1000 + 100,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
      }),
    ).toString("base64url") +
    ".x";
  expect(
    normalizeSubscriptionToken(
      {
        tokens: { access_token: jwt, refresh_token: "r", id_token: "ignored" },
      },
      now,
    ),
  ).toEqual({
    access_token: jwt,
    refresh_token: "r",
    expires_at: now + 100000,
    account_id: "acct",
    project_id: undefined,
  });
});
it("normalizes Claude, Sub2API, Google and refresh-only imports with seconds, milliseconds and ISO expiry", () => {
  expect(
    normalizeSubscriptionToken({
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: now },
    }).expires_at,
  ).toBe(now);
  expect(
    normalizeSubscriptionToken({
      credentials: {
        access_token: "a",
        expires_at: now / 1000,
        project_id: "p",
      },
    }).project_id,
  ).toBe("p");
  expect(
    normalizeSubscriptionToken(
      JSON.stringify({
        access_token: "a",
        expiry_date: new Date(now).toISOString(),
      }),
    ).expires_at,
  ).toBe(now);
  expect(
    normalizeSubscriptionToken({ access_token: "a", expires_in: 3600 }, now)
      .expires_at,
  ).toBe(now + 3600000);
  expect(normalizeSubscriptionToken({ refresh_token: "r" })).toMatchObject({
    refresh_token: "r",
  });
});
it("rejects malformed imports, header injection, impossible expiry and unknown providers without quoting input", () => {
  for (const value of [
    null,
    [],
    { access_token: "a\r\nx-key: bad" },
    { access_token: "a", expires_at: "broken" },
    { access_token: "a", expires_in: -2 },
    { accounts: [{}] },
    "secret-invalid-json",
  ]) {
    expect(() => normalizeSubscriptionToken(value)).toThrow();
    try {
      normalizeSubscriptionToken(value);
    } catch (error) {
      expect(String(error)).not.toContain("secret-invalid-json");
    }
  }
  expect(() => subscriptionKind("constructor")).toThrow();
});
it("keeps quota unknown without provider headers and bounds passive Codex quota snapshots", () => {
  expect(subscriptionQuota("codex", new Headers())).toEqual([]);
  const headers = new Headers({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "120",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "NaN",
  });
  expect(subscriptionQuota("codex", headers, now)).toEqual([
    {
      window: "primary",
      usedPercent: 100,
      resetAt: now + 120000,
      windowMinutes: 300,
    },
  ]);
  expect(subscriptionQuota("antigravity", headers)).toEqual([]);
});
