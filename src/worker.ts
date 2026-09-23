// Worker-role-only entry point. This file imports nothing from `next` and
// listens on no port: it is the same boot sequence `src/instrumentation.ts`
// runs under `next start`, minus the web half. `make build-worker` bundles it
// into dist/worker.mjs and `make worker` runs that bundle as a plain Node
// process; a worker container will run the same bundle later.
import { boot } from "@/server/boot";
import { parseRoles } from "@/server/roles";

// The web role is served by `next start`; this entry cannot serve it, so asking
// for it here is almost certainly a misconfigured deployment.
if (parseRoles(process.env.RADULF_ROLES).has("web")) {
  console.warn(
    "[radulf] RADULF_ROLES includes 'web' but src/worker.ts only runs the worker role; " +
      "start the web role with `next start` (make start) instead.",
  );
}

// Pin the roles so getOrchestrator() builds an active orchestrator rather than
// the passive one a web-only process gets.
process.env.RADULF_ROLES = "worker";

boot(new Set(["worker"])).catch((error) => {
  console.error("[radulf] worker failed to boot:", error);
  process.exit(1);
});
