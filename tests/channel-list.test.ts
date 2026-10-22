import { it, expect } from "vitest";
import type { Upstream, ModelRoute } from "@pluhub/contracts/ai";
import {
  filterChannels,
  setChannelState,
  syncChannelSecrets,
} from "../lib/ai/channel-list.js";

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

it("finds channel IDs, URLs and mapped model aliases while combining status and protocol filters", () => {
  expect(
    filterChannels(
      channels,
      models,
      "PRIMARY private-model-id",
      "enabled",
      "openai-chat",
    ).map(([id]) => id),
  ).toEqual(["first"]);
  expect(
    filterChannels(channels, models, "PUBLIC/CODING", "", "").map(([id]) => id),
  ).toEqual(["first"]);
  expect(
    filterChannels(
      channels,
      models,
      "second.example",
      "disabled",
      "anthropic",
    ).map(([id]) => id),
  ).toEqual(["second"]);
  expect(
    filterChannels(channels, models, "", "disabled", "openai-chat"),
  ).toEqual([]);
  expect(filterChannels(channels, models, "env:FIRST", "", "")).toEqual([]);
});

it("leaves adapter grants untouched on state changes and retains manual grants when channel keys change", () => {
  const plugins = [
    {
      path: "/plugins/upstream-openai-chat",
      config: { secretRefs: ["env:FIRST", "env:MANUAL"], anotherSetting: true },
    },
    {
      path: "C:\\plugins\\official.upstream-anthropic",
      config: { secretRefs: ["env:SECOND"] },
    },
  ];
  const original = structuredClone(plugins);
  const next = structuredClone(channels);
  setChannelState(next, ["first"], false);
  syncChannelSecrets(plugins, channels, next, ["openai-chat", "anthropic"]);
  expect(plugins).toEqual(original);
  next.first!.keyRef = "env:REPLACEMENT";
  syncChannelSecrets(plugins, channels, next, ["openai-chat", "anthropic"]);
  expect(plugins[0]!.config).toEqual({
    secretRefs: ["env:MANUAL", "env:REPLACEMENT"],
    anotherSetting: true,
  });
  expect(plugins[1]).toEqual(original[1]);
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
