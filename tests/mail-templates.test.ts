import { it, expect } from "vitest";
import {
  verificationMail,
  testMail,
  mailLanguage,
  sampleMail,
  mailTemplate,
} from "../lib/mail/templates.js";

const brand = {
  name: "Moe API",
  defaultLanguage: "zh-CN" as const,
  accentColor: "#635bff",
};
it("renders all verification purposes in one language with an equivalent plain-text alternative", () => {
  for (const language of ["zh-CN", "en-US"] as const)
    for (const purpose of ["register", "login", "bind", "reset"] as const) {
      const mail = verificationMail({
        to: "someone@example.test",
        code: "123456",
        purpose,
        language,
        brand,
      });
      expect(mail.html).toContain(`lang="${language}"`);
      expect(mail.html).toContain("123456");
      expect(mail.text).toContain("123456");
      expect(mail.subject).toContain(brand.name);
      expect(mail.text).toContain(
        language === "en-US" ? "10 minutes" : "10 分钟",
      );
      if (language === "en-US")
        expect(mail.html).not.toMatch(/[\u4e00-\u9fff]/);
    }
});
it("validates template selection and clearly marks verification samples without changing real mail", () => {
  expect(mailTemplate(undefined)).toBe("test");
  for (const value of ["", null, 1, {}, "unknown", "<img>"])
    expect(() => mailTemplate(value)).toThrow(/Invalid email template/);
  for (const language of ["zh-CN", "en-US"] as const)
    for (const template of [
      "test",
      "register",
      "login",
      "bind",
      "reset",
    ] as const) {
      expect(mailTemplate(template)).toBe(template);
      const mail = sampleMail(
        "preview@example.test",
        template,
        language,
        brand,
      );
      expect(mail.html).toContain(`lang="${language}"`);
      expect(mail.text).toBeTruthy();
      if (template !== "test") {
        const notice =
          language === "en-US"
            ? "This sample code cannot verify an account."
            : "示例验证码不能用于账号验证。";
        expect(mail.text).toContain(notice);
        expect(mail.html).toContain(notice);
        expect(mail.subject).toContain(
          language === "en-US" ? "Test ·" : "测试 ·",
        );
        const real = verificationMail({
          to: "someone@example.test",
          purpose: template,
          code: "654321",
          language,
          brand,
        });
        expect(real.text).not.toContain(notice);
        expect(real.subject).not.toContain(
          language === "en-US" ? "Test ·" : "测试 ·",
        );
      }
    }
});
it("escapes brand text, rejects invalid codes and excludes the code from subject and preheader", () => {
  const mail = verificationMail({
    to: "someone@example.test",
    purpose: "login",
    language: "en-US",
    code: "123456",
    brand: {
      ...brand,
      name: '<img src=x onerror="x">\r\nBcc: bad',
      accentColor: "red; background:url(x)",
    },
  });
  expect(mail.html).toContain("&lt;img");
  expect(mail.html).not.toContain("<img");
  expect(mail.html).not.toContain("url(x)");
  expect(mail.subject).not.toMatch(/[\r\n]/);
  expect(mail.subject).not.toContain("123456");
  expect(
    mail.html?.match(/<div style="display:none[^>]*>(.*?)<\/div>/)?.[1],
  ).not.toContain("123456");
  expect(() =>
    verificationMail({
      to: "someone@example.test",
      purpose: "login",
      language: "en-US",
      code: "<img>",
      brand,
    }),
  ).toThrow();
});
it("renders SMTP test mail in both languages and resolves account, browser and site preferences", () => {
  for (const language of ["zh-CN", "en-US"] as const) {
    const mail = testMail("someone@example.test", language, brand);
    expect(mail.html).toContain(`lang="${language}"`);
    expect(mail.text).toContain(
      language === "en-US" ? "No action is needed." : "无需进行任何操作。",
    );
    expect(mail.html).not.toContain("123456");
  }
  expect(mailLanguage("en-US", "zh-CN", "zh-CN")).toBe("en-US");
  expect(mailLanguage(null, "en-US", "zh-CN")).toBe("en-US");
  expect(mailLanguage(null, "unsupported", "en-US")).toBe("en-US");
});
