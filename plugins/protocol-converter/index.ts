import { definePlugin, HostError } from "@pluhub/sdk";
import {
  decode,
  encodeRequest,
  decodeResult,
  encodeResult,
} from "../../lib/ai/protocols.js";
const protocols = ["openai-chat", "openai-responses", "anthropic", "gemini"];
import { upstreamEvents, encodeStream } from "../../lib/ai/streams.js";
export default definePlugin({
  setup(host) {
    host.provide(
      "ai.converter@1",
      ({ action, protocol, input, model, streamOptions }, signal) => {
        if (!protocols.includes(protocol))
          throw new HostError("invalid_protocol", "Unsupported protocol");
        if (action === "decode") return decode(protocol, input, model);
        if (action === "encode") return encodeRequest(protocol, input);
        if (action === "decodeResult")
          return decodeResult(protocol, input, model);
        if (action === "encodeResult") return encodeResult(protocol, input);
        if (action === "decodeStream") return upstreamEvents(protocol, input);
        if (action === "encodeStream")
          return encodeStream(protocol, input, model, signal, streamOptions);
        throw new HostError(
          "invalid_operation",
          "Unknown conversion operation",
        );
      },
    );
  },
});
