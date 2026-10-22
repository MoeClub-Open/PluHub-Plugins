export const verificationKinds = ["auth", "mailer", "turnstile"] as const;
export type VerificationKind = (typeof verificationKinds)[number];
export type VerificationDrafts = Partial<
  Record<VerificationKind, Record<string, any>>
>;
export const verificationEntry = (config: any, kind: VerificationKind) =>
  config.plugins.find((p: any) =>
    new RegExp("/(?:official\\.)?" + kind + "$").test(
      p.path.replaceAll("\\", "/"),
    ),
  );
export function readVerification(config: any): VerificationDrafts {
  return Object.fromEntries(
    verificationKinds.flatMap((kind) => {
      const entry = verificationEntry(config, kind);
      return entry ? [[kind, structuredClone(entry.config ?? {})]] : [];
    }),
  );
}
/** Apply all changed services to a fresh host config, then let the host validate
 * and persist the complete transaction. Do not overwrite unrelated changes. */
export function applyVerification(
  config: any,
  baseline: VerificationDrafts,
  drafts: VerificationDrafts,
) {
  const changes: {
    kind: VerificationKind;
    entry: any;
    next: Record<string, any>;
  }[] = [];
  for (const kind of verificationKinds) {
    if (JSON.stringify(drafts[kind]) === JSON.stringify(baseline[kind]))
      continue;
    const entry = verificationEntry(config, kind);
    if (!entry || !drafts[kind])
      throw new Error("验证服务已变化，请刷新后重新配置。");
    if (JSON.stringify(entry.config ?? {}) !== JSON.stringify(baseline[kind]))
      throw new Error("验证配置已被其他操作修改，请刷新后重试。");
    const next = structuredClone(drafts[kind]!);
    if (kind !== "auth") {
      const field = kind === "mailer" ? "passwordRef" : "secretRef";
      const before = baseline[kind]?.[field];
      next.secretRefs = [
        ...new Set([
          ...(next.secretRefs ?? []).filter(
            (ref: string) => ref !== before || ref === next[field],
          ),
          ...(next[field] ? [next[field]] : []),
        ]),
      ];
    }
    changes.push({ kind, entry, next });
  }
  if (changes.length) {
    const combined = readVerification(config);
    for (const { kind, next } of changes) combined[kind] = next;
    if (
      (combined.auth?.emailLoginEnabled ||
        combined.auth?.passwordResetEnabled ||
        combined.auth?.registrationEnabled) &&
      (combined.mailer?.enabled !== true ||
        verificationEntry(config, "mailer")?.enabled === false)
    )
      throw new Error("启用邮箱验证前，请配置并启用邮件发送服务。");
    if (
      Object.values(combined.auth?.captcha ?? {}).some(Boolean) &&
      (combined.turnstile?.enabled !== true ||
        verificationEntry(config, "turnstile")?.enabled === false)
    )
      throw new Error("启用人机验证策略前，请先配置并启用验证服务。");
  }
  for (const { entry, next } of changes) entry.config = next;
  return changes.length;
}
