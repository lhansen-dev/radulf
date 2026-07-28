import { isProviderId, listProviderModels } from "@/server/providers";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ provider: string }> };

/** Models a provider can serve, for the settings and new-card pickers. */
export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { provider } = await params;
    if (!isProviderId(provider)) return err(`unknown provider: ${provider}`, 404);
    try {
      return json({ models: await listProviderModels(provider) });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 502);
    }
  });
}
