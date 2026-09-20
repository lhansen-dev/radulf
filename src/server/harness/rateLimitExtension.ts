import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderId } from "../providers";
import { observeRateLimitHeaders } from "../providerRateLimit";

/**
 * The one inline extension Radulf registers: a passive reader of provider
 * rate-limit headers.
 *
 * Note on `noExtensions` (see createRalphSession): that flag disables
 * extensions discovered on DISK — the operator's and the repository's — which
 * is what context reproducibility requires. `extensionFactories` is a separate
 * loader input that is never gated on it, so this observer runs without
 * reopening the door to anything user-authored.
 *
 * It registers no tool, no command and no context transform. It only reads
 * response metadata after the fact, so it cannot influence the agent's turn.
 */
export function rateLimitExtension(provider: ProviderId) {
  return {
    name: "radulf-rate-limit",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("after_provider_response", (event) => {
        observeRateLimitHeaders(provider, event.headers);
      });
    },
  };
}
