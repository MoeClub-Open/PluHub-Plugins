import { t as tr } from "./i18n.js";
export function billingNote(note?: string) {
  const descriptions: Record<string, string> = {
    "Usage unavailable": "上游未提供完整用量，费用尚未确认。",
    "Canceled before complete usage":
      "请求已取消，未收到完整用量，费用尚未确认。",
    "Response interrupted before settlement": "响应未完整结束，费用尚未确认。",
    "Output limit exceeded": "上游用量超过输出上限，需要核对实际费用。",
    "Host restarted before settlement": "服务重启时请求尚未完成结算。",
    "Usage or cost exceeds supported integer range":
      "上游用量或金额异常，需要人工核对。",
    "Upstream rejected before generation": "上游在生成前拒绝请求，预留已释放。",
  };
  return note ? tr(descriptions[note] ?? note) : "";
}
