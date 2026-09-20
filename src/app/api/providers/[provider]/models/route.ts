import { isProviderId, listProviderModels } from "@/server/providers";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ provider: string }> };

/** Models a provider can serve, for the settings and new-card pickers. */
export async function GET(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { provider } = await params;
    if (!isProviderId(provider)) return err(`unknown provider: ${provider}`, 404);
    // `refresh=1` is the operator pressing "Load models": bypass every cache
    // between here and the provider. The pickers' own mount-time load doesn't
    // set it, so browsing the settings page stays cheap.
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    try {
      return json({ models: await listProviderModels(provider, undefined, { force }) });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 502);
    }
  });
}
