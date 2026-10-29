import { t as tr } from "./i18n.js";
export function billingNote(note?: string) {
  const descriptions: Record<string, string> = {
    "Usage unavailable; charged reserved amount":
      "上游未提供有效用量，已按预扣金额结算。",
    "Invalid usage; charged reserved amount":
      "上游用量无效，已按预扣金额结算。",
    "Invalid usage or cost; charged reserved amount":
      "实际费用无法计算，已按预扣金额结算。",
    "Output limit exceeded; charged reserved amount":
      "上游超过输出上限，已按预扣金额结算。",
    "Recovered request; charged reserved amount":
      "历史未结算请求已按预扣金额结算。",
    "Recovered request settlement": "历史未结算请求已按有效用量结算。",
    "Upstream rejected before generation": "上游在生成前拒绝请求，预扣已释放。",
  };
  return note ? tr(descriptions[note] ?? note) : "";
}
