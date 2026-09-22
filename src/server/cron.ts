/**
 * A five-field cron expression, parsed and matched against a minute.
 *
 * Spec 22. Written here rather than taken from npm: the whole of it is the
 * file below, and the one thing scheduling must never be is a surprise, which
 * is a poor fit for a transitive dependency tree on a project whose
 * SECURITY.md posture is what it is.
 *
 * Minute resolution, server-local time, and no extensions: no seconds field,
 * no `@reboot`, no `?`, no `L`/`W`/`#`. What is supported is what a crontab
 * means by `*`, a number, `a,b`, `a-b`, and `*​/n` or `a-b/n`, plus the
 * three-letter month and weekday names.
 */

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week, where 7 is Sunday as well as 0
] as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A parsed expression: the set of allowed values for each of the five fields. */
export type Cron = {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when both day fields are restricted, which a crontab ORs. */
  bothDayFieldsRestricted: boolean;
};

export class CronError extends Error {}

/** Parse a five-field expression, or throw CronError naming what is wrong. */
export function parseCron(expression: string): Cron {
  const fields = expression.trim().toLowerCase().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `a cron expression has five fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((field, i) =>
    parseField(field, i),
  );
  // 7 and 0 both mean Sunday, so collapse them before anything compares.
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  daysOfWeek.delete(7);
  return {
    expression: expression.trim(),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    bothDayFieldsRestricted: fields[2] !== "*" && fields[4] !== "*",
  };
}

/** True when `expression` parses. For validating an operator's input. */
export function cronError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (cause) {
    return cause instanceof CronError ? cause.message : "that is not a cron expression";
  }
}

/**
 * Does `date` fall in a minute this expression names?
 *
 * The two day fields are OR'd when both are restricted and AND'd otherwise,
 * which is what every crontab does and the one rule nobody expects: `0 0 1 *
 * 1` is the first of the month *and* every Monday, not Mondays that are the
 * first.
 */
export function cronMatches(cron: Cron, date: Date): boolean {
  if (!cron.minutes.has(date.getMinutes())) return false;
  if (!cron.hours.has(date.getHours())) return false;
  if (!cron.months.has(date.getMonth() + 1)) return false;
  const dom = cron.daysOfMonth.has(date.getDate());
  const dow = cron.daysOfWeek.has(date.getDay());
  return cron.bothDayFieldsRestricted ? dom || dow : dom && dow;
}

/** How long a year is in minutes, rounded up past a leap year. */
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

/**
 * The first minute at or after `from` that the expression names, or null when
 * there is none within a year.
 *
 * A minute-by-minute walk. A year of minutes is half a million date
 * comparisons in the worst case, which is only ever reached by an expression
 * that can never match (`0 0 30 2 *`), and is paid once per render rather
 * than per tick.
 */
export function nextCronFire(cron: Cron, from: Date): Date | null {
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  if (candidate < from) candidate.setMinutes(candidate.getMinutes() + 1);
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++) {
    if (cronMatches(cron, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];

function parseField(field: string, index: number): Set<number> {
  const { min, max } = FIELD_RANGES[index];
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) throw new CronError(`empty ${FIELD_NAMES[index]} entry in "${field}"`);
    const [spec, stepText, ...extra] = part.split("/");
    if (extra.length > 0) throw new CronError(`too many steps in "${part}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`step in "${part}" must be a positive whole number`);
    }
    let from: number;
    let to: number;
    if (spec === "*") {
      from = min;
      to = max;
    } else {
      const [startText, endText, ...tooMany] = spec.split("-");
      if (tooMany.length > 0) throw new CronError(`too many dashes in "${part}"`);
      from = namedValue(startText, index);
      // `5/15` means "from 5 to the end of the field, every 15", the same as
      // `5-59/15` in the minute field. Without a step it is just 5.
      to = endText === undefined ? (stepText === undefined ? from : max) : namedValue(endText, index);
    }
    if (from < min || to > max || from > to) {
      throw new CronError(`"${part}" is outside the ${FIELD_NAMES[index]} range ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function namedValue(text: string, index: number): number {
  const names = index === 3 ? MONTHS : index === 4 ? WEEKDAYS : null;
  if (names) {
    const named = names.indexOf(text);
    if (named !== -1) return index === 3 ? named + 1 : named;
  }
  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new CronError(`"${text}" is not a ${FIELD_NAMES[index]} value`);
  }
  return value;
}
