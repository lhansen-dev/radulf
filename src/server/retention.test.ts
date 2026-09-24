import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-retention-");

const { db, settings } = await import("@/db");
const { claimDailySweep, sweepDayKey, RETENTION_SWEEP_MARKER_KEY } = await import("./retention");

function markerValue(): string | undefined {
  return db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RETENTION_SWEEP_MARKER_KEY))
    .get()?.value;
}

describe("claimDailySweep", () => {
  beforeEach(() => {
    db.delete(settings).run();
  });

  it("lets exactly one of two workers claim the same day", () => {
    const at = new Date("2026-09-24T10:00:00Z");
    // Worker A and worker B both reach their sweep timer on the same UTC day.
    expect(claimDailySweep(at)).toBe(true);
    expect(claimDailySweep(at)).toBe(false);
    expect(markerValue()).toBe("2026-09-24");
    expect(RETENTION_SWEEP_MARKER_KEY).toBe("retentionSweepDay");
  });

  it("opens up again on the next day", () => {
    expect(claimDailySweep(new Date("2026-09-24T10:00:00Z"))).toBe(true);
    expect(claimDailySweep(new Date("2026-09-24T23:00:00Z"))).toBe(false);
    expect(claimDailySweep(new Date("2026-09-25T00:30:00Z"))).toBe(true);
    expect(claimDailySweep(new Date("2026-09-25T08:00:00Z"))).toBe(false);
    expect(markerValue()).toBe("2026-09-25");
  });
});

describe("sweepDayKey", () => {
  it("is the UTC calendar date", () => {
    expect(sweepDayKey(new Date("2026-09-24T23:59:59Z"))).toBe("2026-09-24");
  });
});
