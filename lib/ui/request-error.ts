import { t as tr } from "./i18n.js";

export function requestErrorHint(code?: string) {
  const messages: Record<string, string> = {
    subscription_unavailable:
      "订阅账号当前无法使用。请检查授权、额度和模型支持情况，或选择其他可用渠道。",
    group_unavailable: "使用分组已停用或无权访问，请检查密钥分组。",
    group_forbidden: "目标渠道不在使用分组内，请调整分组渠道或路由目标。",
    channel_forbidden: "当前密钥无权使用此渠道，请检查绑定范围。",
    insufficient_balance: "平台余额不足，请充值后重试。",
    price_unavailable: "模型尚未配置有效价格，请联系管理员。",
    model_not_found: "当前使用范围内没有此模型，请重新选择模型或分组。",
    upstream_unavailable: "当前没有可用渠道，请稍后重试或联系管理员。",
  };
  return code && messages[code] ? tr(messages[code]) : "";
}
