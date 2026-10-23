import React from "react";
import { Sparkles } from "lucide-react";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import doubao from "@lobehub/icons-static-svg/icons/doubao-color.svg";
import hunyuan from "@lobehub/icons-static-svg/icons/hunyuan-color.svg";
import cohere from "@lobehub/icons-static-svg/icons/cohere-color.svg";

const logos: [RegExp, string][] = [
  [/gemini|google/i, gemini],
  [/claude|anthropic/i, claude],
  [/deepseek/i, deepseek],
  [/qwen|alibaba|千问/i, qwen],
  [/llama|meta/i, meta],
  [/mistral|mixtral|codestral|devstral/i, mistral],
  [/grok|xai|x\.ai/i, grok],
  [/kimi|moonshot/i, kimi],
  [/glm|zhipu|智谱/i, zhipu],
  [/minimax/i, minimax],
  [/doubao|bytedance|豆包/i, doubao],
  [/hunyuan|tencent|混元/i, hunyuan],
  [/cohere|command-r/i, cohere],
  [/gpt|chatgpt|codex|(?:^|\/)o[134](?:-|$)/i, openai],
  [/^openai$/i, openai],
];

export function ModelLogo({
  model,
  provider,
}: {
  model: string;
  provider: string;
}) {
  const id = React.useId().replace(/:/g, "");
  const svg =
    logos.find(([pattern]) => pattern.test(model))?.[1] ??
    logos.find(([pattern]) => pattern.test(provider))?.[1];
  return svg ? (
    <span
      className="model-logo"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg.replaceAll("_R_0_", id) }}
    />
  ) : (
    <span className="model-logo" aria-hidden="true">
      <Sparkles size={24} strokeWidth={1.5} />
    </span>
  );
}
