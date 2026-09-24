import { describe, expect, it } from "vitest";
import { parseCreateCard, parseUpdateCard } from "./cardValidation";

describe("parseCreateCard plan critic override (spec 30)", () => {
  it("passes through an explicit planCritic flag", () => {
    expect(parseCreateCard({ repoId: "r", title: "t", planCritic: false })).toMatchObject({
      planCritic: false,
    });
  });

  it("keeps null as defer-to-settings and accepts a critic model", () => {
    expect(parseCreateCard({ repoId: "r", title: "t", planCritic: null, criticModel: "m" })).toMatchObject({
      planCritic: null,
      criticModel: "m",
    });
  });

  it("leaves planCritic undefined when omitted", () => {
    expect(parseCreateCard({ repoId: "r", title: "t" }).planCritic).toBeUndefined();
  });

  it("rejects a non-boolean planCritic", () => {
    expect(() => parseCreateCard({ repoId: "r", title: "t", planCritic: "yes" })).toThrow(
      /planCritic must be a boolean or null/,
    );
  });
});

describe("parseUpdateCard plan critic override (spec 30)", () => {
  it("stores null to clear the override", () => {
    expect(parseUpdateCard({ planCritic: null })).toEqual({ planCritic: null });
  });

  it("stores booleans as 1/0", () => {
    expect(parseUpdateCard({ planCritic: true })).toEqual({ planCritic: 1 });
    expect(parseUpdateCard({ planCritic: false })).toEqual({ planCritic: 0 });
  });

  it("accepts criticModel as an optional string", () => {
    expect(parseUpdateCard({ criticModel: "m" })).toEqual({ criticModel: "m" });
    expect(parseUpdateCard({ criticModel: null })).toEqual({ criticModel: null });
  });

  it("rejects a non-boolean planCritic", () => {
    expect(() => parseUpdateCard({ planCritic: "yes" })).toThrow();
  });
});
