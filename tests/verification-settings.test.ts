import { it, expect } from "vitest";
import {
  applyVerification,
  readVerification,
} from "../plugins/console/verification.js";

const config = () => ({
  plugins: [
    { path: "C:\\plugins\\official.auth", config: { secureCookie: true } },
    {
      path: "/plugins/mailer",
      config: {
        enabled: false,
        passwordRef: "env:OLD_MAIL",
        secretRefs: ["env:OLD_MAIL", "env:SHARED_MAIL"],
      },
    },
    {
      path: "/plugins/turnstile",
      config: {
        enabled: false,
        secretRef: "env:OLD_CAPTCHA",
        secretRefs: ["env:OLD_CAPTCHA"],
      },
    },
    { path: "/plugins/ai-router", config: { models: {} } },
  ],
});
it("applies login, email and captcha together while rotating only the service's own secret grant", () => {
  const original = config(),
    baseline = readVerification(original),
    drafts = structuredClone(baseline);
  drafts.auth!.emailLoginEnabled = true;
  drafts.mailer!.enabled = true;
  drafts.mailer!.passwordRef = "env:NEW_MAIL";
  drafts.turnstile!.enabled = true;
  drafts.turnstile!.secretRef = "env:NEW_CAPTCHA";
  const fresh = structuredClone(original);
  expect(applyVerification(fresh, baseline, drafts)).toBe(3);
  expect((fresh.plugins[0]!.config as any).emailLoginEnabled).toBe(true);
  expect(fresh.plugins[1]!.config.secretRefs).toEqual([
    "env:SHARED_MAIL",
    "env:NEW_MAIL",
  ]);
  expect(fresh.plugins[2]!.config.secretRefs).toEqual(["env:NEW_CAPTCHA"]);
  expect(fresh.plugins[3]).toEqual(original.plugins[3]);
  expect(original.plugins[1]!.config.passwordRef).toBe("env:OLD_MAIL");
});
it("rejects conflicting updates without partially mutating any plugin and keeps concurrent untouched fields", () => {
  const original = config(),
    baseline = readVerification(original),
    drafts = structuredClone(baseline);
  drafts.mailer!.enabled = true;
  drafts.turnstile!.enabled = true;
  const fresh = structuredClone(original);
  fresh.plugins[2]!.config.secretRef = "env:OTHER_EDIT";
  const before = structuredClone(fresh);
  expect(() => applyVerification(fresh, baseline, drafts)).toThrow(/修改/);
  expect(fresh).toEqual(before);
  delete drafts.turnstile;
  drafts.turnstile = baseline.turnstile;
  expect(applyVerification(fresh, baseline, drafts)).toBe(1);
  expect(fresh.plugins[2]).toEqual(before.plugins[2]);
});

it("rejects policies whose email or captcha service is disabled without writing partial changes", () => {
  for (const patch of [
    { emailLoginEnabled: true },
    { passwordResetEnabled: true },
    { captcha: { login: true } },
  ]) {
    const original = config(),
      baseline = readVerification(original),
      drafts = structuredClone(baseline);
    Object.assign(drafts.auth!, patch);
    const before = structuredClone(original);
    expect(() => applyVerification(original, baseline, drafts)).toThrow(/启用/);
    expect(original).toEqual(before);
  }
});
