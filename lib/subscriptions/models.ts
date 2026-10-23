import { HostError, type Host } from "@pluhub/sdk";
import {
  subscriptionModels,
  type SubscriptionModel,
} from "../ai/subscription-models.js";
import { responseObject } from "../ai/json-response.js";
import type {
  SubscriptionKind,
  SubscriptionToken,
} from "../ai/subscription-auth.js";
import {
  antigravityAvailableModels,
  discoverAntigravityProject,
} from "../ai/antigravity-control.js";

export async function accountSubscriptionModels(
  host: Host,
  kind: SubscriptionKind,
  token: SubscriptionToken,
  signal: AbortSignal,
): Promise<SubscriptionModel[]> {
  if (kind === "antigravity") {
    const project =
      token.project_id ??
      (await discoverAntigravityProject(host, token.access_token!, signal));
    const models = await antigravityAvailableModels(
      host,
      token.access_token!,
      project,
      signal,
    );
    return Object.entries(models).map(([id, value]) => ({
      id,
      name: (value as any).displayName ?? id,
    }));
  }
  if (token.auth_mode !== "siwc")
    return subscriptionModels(host, kind, token.plan_type, signal);
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      publicOnly: true,
      headers: {
        authorization: "Bearer " + token.access_token,
      },
    },
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new HostError(
      "model_discovery",
      "Unable to load account models",
      502,
    );
  }
  const data = await responseObject(response, signal);
  const models = data.models?.filter((m: any) => m.visibility === "list");
  if (!Array.isArray(models))
    throw new HostError(
      "model_discovery",
      "Invalid account model response",
      502,
    );
  return models.flatMap((m: any) => {
    const id = m.slug;
    return typeof id === "string" && id
      ? [
          {
            id,
            name: m.display_name ?? m.name ?? id,
            contextLength: m.context_window ?? m.context_length,
          },
        ]
      : [];
  });
}
