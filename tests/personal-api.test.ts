import { it, expect } from "vitest";
import { parseApiConnection } from "../lib/ai/personal-api.js";
it("imports New API connection exports and common API property aliases", () => {
  expect(
    parseApiConnection(
      JSON.stringify({
        _type: "newapi_channel_conn",
        url: "https://example.com/v1/",
        key: "secret",
      }),
    ),
  ).toEqual({
    protocol: "openai-chat",
    preset: "newapi",
    baseUrl: "https://example.com/v1",
    key: "secret",
  });
  expect(
    parseApiConnection(
      JSON.stringify({
        name: "Mine",
        base_url: "https://api.example",
        api_key: "secret",
        protocol: "anthropic",
      }),
    ),
  ).toMatchObject({ name: "Mine", protocol: "anthropic", preset: "custom" });
});
it.each([
  null,
  [],
  { url: "http://a:b@example.com", key: "k" },
  { url: "https://example.com/?key=x", key: "k" },
  { url: "file:///secret", key: "k" },
  { url: "https://example.com", key: "k\nheader" },
])("rejects invalid API imports without using the data", (value) => {
  expect(() => parseApiConnection(JSON.stringify(value))).toThrow();
});
