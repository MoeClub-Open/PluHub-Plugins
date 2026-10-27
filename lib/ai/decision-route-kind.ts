/** Decision adapters use their own request formats, never the chat protocol. */
export const isDecisionProtocol = (protocol: string | undefined): protocol is "systemone" | "luna" | "jev" =>
  protocol === "systemone" || protocol === "luna" || protocol === "jev";

export const routeKindForProtocol = (protocol: string | undefined) =>
  isDecisionProtocol(protocol) ? protocol : "chat";
