import { it, expect } from "vitest";
import {
  brandColors,
  contrast,
  defaultBranding,
  readBranding,
} from "../plugins/console/branding.js";

it("exports only declared public fields and rejects active URLs, SVG uploads and malformed branding", () => {
  expect(readBranding({ secretRefs: ["env:PRIVATE"] })).toEqual(
    defaultBranding,
  );
  for (const branding of [
    { name: "" },
    { unknown: "private" },
    { accentColor: "red" },
    { logoUrl: "javascript:alert(1)" },
    { faviconUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    { termsUrl: "//untrusted.example/path" },
    { websiteUrl: "https://user:password@example.com" },
    { logoUrl: "/\\untrusted.example" },
    { name: "x".repeat(65) },
  ])
    expect(() => readBranding({ branding })).toThrow();
  expect(
    readBranding({
      branding: { logoUrl: "data:image/png;base64,aGVsbG8=", name: "  Demo  " },
    }).name,
  ).toBe("Demo");
  expect(
    readBranding({ branding: { loginTitle: "", loginDescription: "" } }),
  ).toMatchObject({ loginTitle: "", loginDescription: "" });
});

it("maintains accessible accent and button contrast for light, dark and extreme brand colors", () => {
  for (const dark of [true, false])
    for (const color of [
      "#ffffff",
      "#000000",
      "#635bff",
      "#ffcc00",
      "#777777",
      "#00ff88",
    ]) {
      const colors = brandColors(color, dark);
      expect(
        contrast(colors.accent, dark ? "#171c29" : "#ffffff"),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accent, colors.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accent, colors.soft)).toBeGreaterThanOrEqual(4.5);
    }
});
