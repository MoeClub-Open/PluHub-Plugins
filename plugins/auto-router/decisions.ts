import { HostError, type Host } from "@pluhub/sdk";
import type { AIRequest } from "@pluhub/contracts/ai";
import type { DecisionBackend } from "@pluhub/contracts/routing";
import { difficulties, type DifficultyDecision } from "../../lib/ai/decision-protocol.js";
export { difficulties, decisionBody, parseDecision, type DifficultyDecision } from "../../lib/ai/decision-protocol.js";

export function rulesDecision(request: AIRequest): DifficultyDecision {
  const text = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => m.text)
    .join("\n");
  let score = 0;
  if (text.length > 1500) score++;
  if (text.length > 8000) score++;
  if (request.tools.length || request.webSearch) score++;
  if (request.messages.some((m) => m.calls?.length || m.role === "tool"))
    score++;
  if (
    /```|stack\s*trace|traceback|debug|调试|证明|推导|算法|architecture|架构|复杂|security|安全分析|optimi[sz]/i.test(
      text,
    )
  )
    score++;
  if (
    /research|多约束|形式化|并发|distributed|分布式|漏洞|theorem|NP[- ]hard/i.test(
      text,
    )
  )
    score++;
  const level = Math.min(3, score);
  return { difficulty: difficulties[level]!, confidence: 1, source: "rules" };
}
export async function decide(
  host: Host,
  config: DecisionBackend,
  request: AIRequest,
  signal: AbortSignal,
  scope?: { profile: string; token?: string },
): Promise<DifficultyDecision> {
  if (config.kind === "rules") return rulesDecision(request);
  if (!scope?.token)
    throw new HostError("decision_preview_unsupported", "远程决策请通过渠道测试请求验证", 400);
  return host.call<DifficultyDecision>("ai.workflow-decision@1", scope, signal);
}
