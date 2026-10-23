import { expect, it } from "vitest";
import type { Upstream } from "@pluhub/contracts/ai";
import { channelEditorTarget } from "../lib/ui/channel-location.js";

const channels: Record<string, Upstream> = {
  "provider/a": {
    flow: {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: "p" },
        { id: "p", type: "provider" },
      ],
    },
  },
  smart: {
    flow: {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "routing", profile: "balanced" },
      ],
    },
  },
};

it("opens bookmarks in the corresponding channel editor and preserves old settings links", () => {
  expect(channelEditorTarget("#/channels", channels)).toBeUndefined();
  expect(
    channelEditorTarget("#/channels?channel=provider%2Fa", channels),
  ).toEqual({
    channelId: "provider/a",
    panel: undefined,
  });
  for (const query of ["panel=limits", "tab=protection"])
    expect(channelEditorTarget("#/channels?" + query, channels)).toEqual({
      channelId: "provider/a",
      panel: "limits",
    });
  for (const query of ["panel=routing", "tab=policies"])
    expect(channelEditorTarget("#/channels?" + query, channels)).toEqual({
      channelId: "smart",
      panel: "routing",
    });
});

it("never silently substitutes another channel for a deleted or invalid bookmark", () => {
  for (const id of ["missing", "__proto__", "constructor", ""])
    expect(
      channelEditorTarget("#/channels?panel=limits&channel=" + id, channels),
    ).toBeUndefined();
  expect(channelEditorTarget("#/channels?panel=limits", {})).toBeUndefined();
  expect(
    channelEditorTarget("#/channels?panel=unknown", channels),
  ).toBeUndefined();
  expect(
    channelEditorTarget("#/channels?panel=routing", {
      only: channels["provider/a"]!,
    }),
  ).toEqual({
    channelId: "only",
    panel: "routing",
  });
});
