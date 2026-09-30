// The boot sequence lives in src/server/boot.ts so src/worker.ts can run it
// without Next; this hook only selects the roles and hands off.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("@/server/boot");
    const { activeRoles } = await import("@/server/roles");
    await boot(activeRoles());
  }
}
