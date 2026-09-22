import { describe, expect, it } from "vitest";
import { cardMatches } from "./cardSearch";

const card = (title: string, description = "") => ({ title, description });

describe("cardMatches", () => {
  it("matches everything when nothing has been typed", () => {
    expect(cardMatches(card("Anything"), "")).toBe(true);
    expect(cardMatches(card("Anything"), "   ")).toBe(true);
  });

  it("matches on the title, ignoring case", () => {
    expect(cardMatches(card("Widen the alert webhook"), "ALERT")).toBe(true);
    expect(cardMatches(card("Widen the alert webhook"), "sandbox")).toBe(false);
  });

  it("matches on the description, which is where the detail usually is", () => {
    expect(cardMatches(card("Polish", "Add transcript search to the card page"), "transcript")).toBe(true);
  });

  it("ignores whitespace around the query", () => {
    expect(cardMatches(card("Seccomp filter"), "  seccomp  ")).toBe(true);
  });

  it("matches a substring inside a word, so a partial recall still finds it", () => {
    expect(cardMatches(card("Reconnect the event stream"), "connect")).toBe(true);
  });
});
