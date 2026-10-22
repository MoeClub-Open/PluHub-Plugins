import { t as tr } from "../../lib/ui/i18n.js";
const authMessages: Record<string, string> = {
  get "Invalid or already used verification code"() {
    return tr("动态码或恢复码不正确、已使用，请重试。");
  },
  get "Password recovery expired or changed; start again"() {
    return tr("恢复流程已过期或账号信息已变更，请重新发送验证码。");
  },
  get "Password recovery is disabled"() {
    return tr("站点暂未开放邮箱找回密码。");
  },
  get "Invalid username or password"() {
    return tr("用户名或密码不正确。");
  },
  get "Invalid email verification code"() {
    return tr("邮箱验证码不正确，请检查后重试。");
  },
  get "Verification expired or is invalid; start again"() {
    return tr("验证码已过期或失效，请重新发送。");
  },
  get "Challenge already used"() {
    return tr("验证码已使用，请重新发送。");
  },
  get "Invalid username"() {
    return tr(
      "用户名格式不正确，请使用 3–64 位字母、数字、下划线、点或短横线。",
    );
  },
  get "This account cannot be registered"() {
    return tr("该账号暂时无法注册，请更换用户名或返回登录。");
  },
  get "Registration is disabled"() {
    return tr("站点已暂停注册。");
  },
  get "Email delivery is not enabled"() {
    return tr("暂时无法发送验证码，请稍后重试或联系站点支持。");
  },
  get "Password must contain 12–1024 characters"() {
    return tr("密码长度应为 12–1024 个字符。");
  },
};
export const authError = (detail: string) =>
  Object.hasOwn(authMessages, detail) ? authMessages[detail]! : tr(detail);
