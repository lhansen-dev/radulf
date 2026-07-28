import { PROMPT_TEMPLATE_DEFAULTS } from "@/server/settings";
import { json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(PROMPT_TEMPLATE_DEFAULTS);
}
