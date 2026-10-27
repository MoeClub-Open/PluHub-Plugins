import { HostError, type Host } from "@pluhub/sdk";
import type { Usage } from "@pluhub/contracts/ai";
import { rawBody } from "../http/body.js";
import { prepareBeforeGeneration, upstreamRejection } from "./rejection.js";
import { upstreamUrl } from "./upstream-interfaces.js";

export type JevValue =
  | string
  | number
  | boolean
  | null
  | JevValue[]
  | { [key: string]: JevValue };

export type JevQuestion =
  | { type: "choice"; instructions: JevValue; criteria: Record<string, JevValue> }
  | { type: "score"; instructions: JevValue; criteria: JevValue[] }
  | {
      type: "noul";
      instructions: JevValue;
      criteria?: { true?: JevValue; false?: JevValue };
    }
  | { type: "box"; instructions: JevValue };

export interface JevRequest {
  model: string;
  state: string | JevValue[] | { [key: string]: JevValue };
  questions: Record<string, JevQuestion>;
  assets?: Record<string, { type?: "image"; format: "png" | "jpg" | "jpeg"; data_base64: string }>;
}

export interface JevConnection {
  /** Base URL, with or without the /v1 suffix. */
  baseUrl: string;
  keyRef?: string;
  publicOnly?: boolean;
  timeoutMs?: number;
  longContext?: boolean;
}

export interface JevResult {
  model: string;
  /** Native typed answer objects, keyed by question ID. */
  answers: Record<string, unknown>;
  /** Absent unless the upstream supplied both valid counters. */
  usage?: Usage;
}

function hasAnswers(answers: unknown, questions: JevRequest["questions"]): boolean {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  return Object.entries(questions).every(([id, question]) => {
    const answer = (answers as Record<string, any>)[id];
    if (!answer || typeof answer !== "object" || answer.type !== question.type) return false;
    switch (question.type) {
      case "choice":
        return typeof answer.choice === "string" && Object.hasOwn(question.criteria, answer.choice);
      case "score":
        return Number.isFinite(answer.score);
      case "noul":
        return Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
      case "box":
        return ["top", "bottom", "left", "right"].every((edge) => Number.isFinite(answer.box?.[edge]));
    }
  });
}

/** Execute a TypeSafe System One evaluation. Billing and logging are owned by the caller. */
export async function requestJev(
  host: Host,
  connection: JevConnection,
  request: JevRequest,
  signal: AbortSignal,
  resolvedKey?: string,
): Promise<JevResult> {
  const { url, body, key } = prepareBeforeGeneration(() => ({
    url: upstreamUrl(connection.baseUrl, "/v1/systemone").href,
    body: JSON.stringify(request),
    key: resolvedKey ?? (connection.keyRef ? host.secret(connection.keyRef) : undefined),
  }));
  const images =
    !!Object.keys(request.assets ?? {}).length ||
    Object.values(request.questions).some((question) => question.type === "box");
  const active = connection.timeoutMs
    ? AbortSignal.any([signal, AbortSignal.timeout(connection.timeoutMs)])
    : signal;
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(images ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
        ...(connection.longContext
          ? { "TypeSafe-Danger-Zone-Long-Context": "true" }
          : {}),
      },
      body,
      publicOnly: connection.publicOnly,
    },
    active,
  );
  if (!response.ok) {
    await response.body?.cancel();
    const error = upstreamRejection(response.status);
    // These System One responses explicitly reject the request before evaluation.
    if ([413, 415, 529].includes(response.status)) error.generationRejected = true;
    throw error;
  }
  let data: any;
  try {
    const bytes = await rawBody(
      new Request("http://jev-response", {
        method: "POST",
        body: response.body,
        duplex: "half",
        signal: active,
      } as RequestInit),
      16 * 1024 * 1024,
    );
    data = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (active.aborted) throw active.reason;
    throw new HostError("upstream_protocol", "Invalid Jev response", 502);
  }
  const input = data?.usage?.input_tokens;
  const output = data?.usage?.output_tokens;
  const usage = [input, output].every((n) => Number.isSafeInteger(n) && n >= 0)
    ? { input, output }
    : undefined;
  if (
    typeof data?.model !== "string" ||
    !data.model ||
    !hasAnswers(data.answers, request.questions)
  ) {
    // A malformed response may still contain billable usage; preserve it for settlement.
    throw Object.assign(new HostError("upstream_protocol", "Invalid Jev response", 502), {
      usage,
    });
  }
  return { model: data.model, answers: data.answers, ...(usage ? { usage } : {}) };
}
