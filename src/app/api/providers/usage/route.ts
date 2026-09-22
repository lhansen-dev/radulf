import { desc } from "drizzle-orm";
import { db, runs } from "@/db";
import { providerBreakerStatus } from "@/server/circuitBreaker";
import { PROVIDERS } from "@/server/providers";
import { computeProviderUsage, USAGE_WINDOW_HOURS } from "@/server/providerUsage";
import { readProviderRateLimit } from "@/server/providerRateLimit";
import { json } from "../../_lib";

// Enough to cover the window on a busy day without scanning the full history;
// the window filter in computeProviderUsage does the real narrowing.
const MAX_USAGE_RUNS = 2_000;

export async function GET(req: Request) {
  const windowHours = Number(new URL(req.url).searchParams.get("windowHours")) || USAGE_WINDOW_HOURS;
  const recent = db
    .select({
      provider: runs.provider,
      status: runs.status,
      startedAt: runs.startedAt,
      promptTokens: runs.promptTokens,
      completionTokens: runs.completionTokens,
      costUsd: runs.costUsd,
    })
    .from(runs)
    .orderBy(desc(runs.startedAt))
    .limit(MAX_USAGE_RUNS)
    .all();

  return json({
    windowHours,
    providers: computeProviderUsage({
      runs: recent,
      breakers: PROVIDERS.map(({ id }) => providerBreakerStatus(id)),
      rateLimits: PROVIDERS.map(({ id }) => readProviderRateLimit(id)).filter((r) => r !== null),
      nowMs: Date.now(),
      windowHours,
    }),
  });
}
