import { db, iterations } from "@/db";
import { computeRolloutAcceptance } from "@/server/analytics";
import type { RolloutAcceptance } from "@/server/analytics";
import {
  launchBenchmark,
  listActiveBenchmarks,
  listFixtures,
  listReports,
} from "@/server/benchmarks";
import type { ActiveBenchmark, BenchmarkFixture, BenchmarkReport } from "@/server/benchmarks";
import { json, err, handle } from "../_lib";

export const dynamic = "force-dynamic";

export type BenchmarksResponse = {
  fixtures: BenchmarkFixture[];
  reports: BenchmarkReport[];
  active: ActiveBenchmark[];
  rollout: RolloutAcceptance;
};

export async function GET() {
  const allIterations = db
    .select({
      id: iterations.id,
      runId: iterations.runId,
      n: iterations.n,
      promptTokens: iterations.promptTokens,
      completionTokens: iterations.completionTokens,
      modelTurns: iterations.modelTurns,
      startedAt: iterations.startedAt,
      endedAt: iterations.endedAt,
    })
    .from(iterations)
    .all();

  const response: BenchmarksResponse = {
    fixtures: listFixtures(),
    reports: listReports(),
    active: listActiveBenchmarks(),
    rollout: computeRolloutAcceptance(allIterations),
  };
  return json(response);
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await req.json();
    const cookie = req.headers.get("cookie") ?? "";
    if (!cookie) return err("missing session cookie");

    const runs = Number(body.runs ?? 3);
    if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
      return err("runs must be an integer between 1 and 10");
    }

    const started = launchBenchmark({
      fixture: String(body.fixture ?? ""),
      repoId: String(body.repoId ?? ""),
      provider: String(body.provider ?? ""),
      model: String(body.model ?? ""),
      plannerModel: String(body.plannerModel ?? ""),
      runs,
      maxIterations: body.maxIterations ? Number(body.maxIterations) : undefined,
      timeoutMinutes: body.timeoutMinutes ? Number(body.timeoutMinutes) : undefined,
      autoReview: Boolean(body.autoReview),
      cookie,
      baseUrl: new URL(req.url).origin,
    });
    return json(started, 201);
  });
}
