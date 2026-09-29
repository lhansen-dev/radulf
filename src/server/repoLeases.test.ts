import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-repo-leases-");

const { db, now, repoLeases, workers } = await import("@/db");
const { acquireRepoLease, releaseRepoLease, releaseStaleLeases, releaseLeasesHeldBy, leaseHolder } =
  await import("./repoLeases");

const STALE_SECONDS = 120;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function seedWorker(id: string, heartbeatAt: string) {
  db.insert(workers)
    .values({ id, host: "h", pid: 1, roles: "[]", startedAt: heartbeatAt, heartbeatAt })
    .run();
}

describe("repoLeases", () => {
  beforeEach(() => {
    db.delete(repoLeases).run();
    db.delete(workers).run();
    seedWorker("live-a", now());
    seedWorker("live-b", now());
    seedWorker("dead", minutesAgo(10));
  });

  it("acquires a free repo", () => {
    expect(leaseHolder("/repo/x")).toBeNull();
    expect(acquireRepoLease("/repo/x", "live-a", STALE_SECONDS)).toBe(true);
    expect(leaseHolder("/repo/x")).toBe("live-a");
  });

  it("refuses a second worker while a live holder has it", () => {
    expect(acquireRepoLease("/repo/x", "live-a", STALE_SECONDS)).toBe(true);
    expect(acquireRepoLease("/repo/x", "live-b", STALE_SECONDS)).toBe(false);
    expect(leaseHolder("/repo/x")).toBe("live-a");
  });

  it("does not let the same worker re-acquire its own held lease", () => {
    expect(acquireRepoLease("/repo/x", "live-a", STALE_SECONDS)).toBe(true);
    expect(acquireRepoLease("/repo/x", "live-a", STALE_SECONDS)).toBe(false);
    expect(leaseHolder("/repo/x")).toBe("live-a");
  });

  it("takes over a lease held by a stale worker", () => {
    db.insert(repoLeases)
      .values({ repoPath: "/repo/x", workerId: "dead", acquiredAt: minutesAgo(10) })
      .run();
    expect(acquireRepoLease("/repo/x", "live-a", STALE_SECONDS)).toBe(true);
    expect(leaseHolder("/repo/x")).toBe("live-a");
  });

  it("works through a transaction handle", () => {
    const ok = db.transaction((tx) => acquireRepoLease("/repo/x", "live-a", STALE_SECONDS, tx), {
      behavior: "immediate",
    });
    expect(ok).toBe(true);
    expect(leaseHolder("/repo/x")).toBe("live-a");
  });

  it("releaseRepoLease only deletes when the worker matches", () => {
    acquireRepoLease("/repo/x", "live-a", STALE_SECONDS);
    releaseRepoLease("/repo/x", "live-b");
    expect(leaseHolder("/repo/x")).toBe("live-a");
    releaseRepoLease("/repo/x", "live-a");
    expect(leaseHolder("/repo/x")).toBeNull();
  });

  it("releaseStaleLeases frees only dead holders", () => {
    acquireRepoLease("/repo/a", "live-a", STALE_SECONDS);
    acquireRepoLease("/repo/b", "live-b", STALE_SECONDS);
    db.insert(repoLeases)
      .values({ repoPath: "/repo/c", workerId: "dead", acquiredAt: minutesAgo(10) })
      .run();
    db.insert(repoLeases)
      .values({ repoPath: "/repo/d", workerId: "gone", acquiredAt: minutesAgo(10) })
      .run();

    const released = releaseStaleLeases(new Set(["live-a", "live-b"]));
    expect(released.sort()).toEqual(["/repo/c", "/repo/d"]);
    expect(leaseHolder("/repo/a")).toBe("live-a");
    expect(leaseHolder("/repo/b")).toBe("live-b");
    expect(leaseHolder("/repo/c")).toBeNull();
    expect(leaseHolder("/repo/d")).toBeNull();
  });

  it("releaseLeasesHeldBy frees only that worker's leases", () => {
    db.insert(repoLeases).values({ repoPath: "/repo/x", workerId: "live-a", acquiredAt: now() }).run();
    db.insert(repoLeases).values({ repoPath: "/repo/y", workerId: "live-b", acquiredAt: now() }).run();
    expect(releaseLeasesHeldBy("live-a")).toEqual(["/repo/x"]);
    expect(leaseHolder("/repo/x")).toBeNull();
    expect(leaseHolder("/repo/y")).toBe("live-b");
    expect(releaseLeasesHeldBy("nobody")).toEqual([]);
  });

  it("releaseStaleLeases with no live workers frees everything", () => {
    acquireRepoLease("/repo/a", "live-a", STALE_SECONDS);
    expect(releaseStaleLeases(new Set())).toEqual(["/repo/a"]);
    expect(leaseHolder("/repo/a")).toBeNull();
  });
});
