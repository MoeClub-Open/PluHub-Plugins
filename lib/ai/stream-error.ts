/** Only gateway-owned, fixed descriptions may cross a provider's stream boundary. */
export function streamError(error: unknown) {
  return (error as { code?: unknown } | undefined)?.code ===
    "upstream_budget_exceeded"
    ? {
        code: "upstream_budget_exceeded",
        message: "Upstream usage exceeded the output token limit",
      }
    : { code: "upstream_error", message: "Upstream stream failed" };
}
