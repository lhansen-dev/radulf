import { afterEach, describe, expect, it } from "vitest";
import { activeRoles, hasRole, parseRoles, ROLES } from "./roles";

describe("parseRoles", () => {
  it("defaults to both roles when unset or blank", () => {
    expect([...parseRoles(undefined)].sort()).toEqual([...ROLES].sort());
    expect([...parseRoles("")].sort()).toEqual([...ROLES].sort());
    expect([...parseRoles("   ")].sort()).toEqual([...ROLES].sort());
  });

  it("parses a single role", () => {
    expect([...parseRoles("web")]).toEqual(["web"]);
  });

  it("parses both roles in any order", () => {
    expect([...parseRoles("worker,web")].sort()).toEqual(["web", "worker"]);
  });

  it("trims whitespace and drops empty parts", () => {
    expect([...parseRoles(" worker , ")]).toEqual(["worker"]);
  });

  it("rejects unknown roles, naming the offender", () => {
    expect(() => parseRoles("edge")).toThrow(/edge/);
  });
});

describe("activeRoles / hasRole", () => {
  const previous = process.env.RADULF_ROLES;

  afterEach(() => {
    if (previous === undefined) delete process.env.RADULF_ROLES;
    else process.env.RADULF_ROLES = previous;
  });

  it("reads RADULF_ROLES fresh on every call", () => {
    delete process.env.RADULF_ROLES;
    expect(hasRole("worker")).toBe(true);
    expect([...activeRoles()].sort()).toEqual(["web", "worker"]);

    process.env.RADULF_ROLES = "web";
    expect(hasRole("worker")).toBe(false);
    expect(hasRole("web")).toBe(true);
  });
});
