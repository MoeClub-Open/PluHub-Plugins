import { it, expect } from "vitest";
import type { Upstream, ModelRoute } from "@pluhub/contracts/ai";
import { filterChannels, setChannelState } from "../lib/ai/channel-list.js";

const channels: Record<string, Upstream> = {
  first: {
    protocol: "openai-chat",
    baseUrl: "https://first.example/v1",
    keyRef: "env:FIRST",
    name: "Primary",
  },
  second: {
    protocol: "anthropic",
    baseUrl: "https://second.example",
    keyRef: "env:SECOND",
    name: "Backup",
    enabled: false,
  },
};
const models: Record<string, ModelRoute> = {
  "public/coding": {
    upstream: "first",
    model: "private-model-id",
    name: "Coding model",
  },
  other: { upstream: "second", model: "another-model", enabled: false },
};

it("finds channel IDs, URLs, protocols and mapped model aliases while filtering status", () => {
  expect(
    filterChannels(
      channels,
      models,
      "PRIMARY private-model-id openai-chat",
      "enabled",
    ).map(([id]) => id),
  ).toEqual(["first"]);
  expect(
    filterChannels(channels, models, "PUBLIC/CODING", "").map(([id]) => id),
  ).toEqual(["first"]);
  expect(
    filterChannels(
      channels,
      models,
      "second.example anthropic",
      "disabled",
    ).map(([id]) => id),
  ).toEqual(["second"]);
  expect(
    filterChannels(channels, models, "openai-chat", "disabled"),
  ).toEqual([]);
  expect(filterChannels(channels, models, "env:FIRST", "")).toEqual([]);
});

it("updates exactly the explicit selection and rejects stale IDs before changing any channel", () => {
  const updated = structuredClone(channels);
  expect(() => setChannelState(updated, ["first", "removed"], false)).toThrow(
    "重新选择",
  );
  expect(updated).toEqual(channels);
  setChannelState(updated, ["first"], false);
  expect(updated.first?.enabled).toBe(false);
  expect(updated.second).toEqual(channels.second);
  setChannelState(updated, ["first", "second"], true);
  expect(
    Object.values(updated).every((channel) => channel.enabled === true),
  ).toBe(true);
  expect(models.other?.enabled).toBe(false);
});
