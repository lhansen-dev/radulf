import { describe, expect, it } from "vitest";
import { cronError, cronMatches, nextCronFire, parseCron } from "./cron";

/** Local time, because that is the time zone spec 22 evaluates in. */
const at = (iso: string) => new Date(iso);

const matches = (expression: string, iso: string) => cronMatches(parseCron(expression), at(iso));

describe("parseCron", () => {
  it("expands stars, numbers, lists, ranges and steps", () => {
    const cron = parseCron("0,30 9-17/4 * * *");

    expect([...cron.minutes]).toEqual([0, 30]);
    expect([...cron.hours]).toEqual([9, 13, 17]);
    expect(cron.daysOfMonth.size).toBe(31);
    expect(cron.months.size).toBe(12);
  });

  it("takes month and weekday names", () => {
    expect([...parseCron("0 0 * jan-mar *").months]).toEqual([1, 2, 3]);
    expect([...parseCron("0 0 * * mon,fri").daysOfWeek]).toEqual([1, 5]);
  });

  it("treats both 0 and 7 as Sunday, and never keeps 7", () => {
    const cron = parseCron("0 0 * * 7");
    expect([...cron.daysOfWeek]).toEqual([0]);
    expect(matches("0 0 * * 7", "2026-09-20T00:00:00")).toBe(true); // a Sunday
  });

  it("reads a bare step as running to the end of the field", () => {
    // `5/15` in the minute field is 5-59/15, as crontab reads it.
    expect([...parseCron("5/15 * * * *").minutes]).toEqual([5, 20, 35, 50]);
    // Without a step it is the single value and nothing more.
    expect([...parseCron("5 * * * *").minutes]).toEqual([5]);
  });

  it("names what is wrong instead of matching nothing", () => {
    expect(cronError("0 0 * *")).toMatch(/five fields/);
    expect(cronError("60 * * * *")).toMatch(/minute range 0-59/);
    expect(cronError("0 * * * 8")).toMatch(/day-of-week range 0-7/);
    expect(cronError("*/0 * * * *")).toMatch(/positive whole number/);
    expect(cronError("0 1-2-3 * * *")).toMatch(/too many dashes/);
    expect(cronError("x * * * *")).toMatch(/not a minute value/);
    expect(cronError("0 0 * * mon")).toBeNull();
  });
});

describe("cronMatches", () => {
  it("matches on the minute, and not on the ones either side", () => {
    expect(matches("30 3 * * *", "2026-09-22T03:30:00")).toBe(true);
    expect(matches("30 3 * * *", "2026-09-22T03:29:59")).toBe(false);
    expect(matches("30 3 * * *", "2026-09-22T03:31:00")).toBe(false);
  });

  it("ANDs the day fields when only one is restricted", () => {
    // Weekdays at 09:00, and 2026-09-19 is a Saturday.
    expect(matches("0 9 * * 1-5", "2026-09-18T09:00:00")).toBe(true);
    expect(matches("0 9 * * 1-5", "2026-09-19T09:00:00")).toBe(false);
  });

  it("ORs the day fields when both are restricted, as every crontab does", () => {
    // The 1st of the month OR any Monday — not Mondays that are the 1st.
    const expression = "0 0 1 * 1";
    expect(matches(expression, "2026-10-01T00:00:00")).toBe(true); // a Thursday
    expect(matches(expression, "2026-09-21T00:00:00")).toBe(true); // a Monday
    expect(matches(expression, "2026-09-22T00:00:00")).toBe(false); // neither
  });
});

describe("nextCronFire", () => {
  it("returns the current minute when it matches, and the next one otherwise", () => {
    const nightly = parseCron("0 3 * * *");

    expect(nextCronFire(nightly, at("2026-09-22T03:00:00"))?.toISOString())
      .toBe(at("2026-09-22T03:00:00").toISOString());
    expect(nextCronFire(nightly, at("2026-09-22T03:00:01"))?.toISOString())
      .toBe(at("2026-09-23T03:00:00").toISOString());
    expect(nextCronFire(nightly, at("2026-09-22T12:00:00"))?.toISOString())
      .toBe(at("2026-09-23T03:00:00").toISOString());
  });

  it("gives up rather than looping forever on an expression that can never match", () => {
    expect(nextCronFire(parseCron("0 0 30 2 *"), at("2026-09-22T00:00:00"))).toBeNull();
  });
});
