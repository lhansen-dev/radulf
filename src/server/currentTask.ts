import fs from "node:fs";
import { firstUnchecked } from "./checklist";

/**
 * Parse a PLAN.md string and return the first unchecked task after the
 * `## Tasks` heading — i.e. the first `- [ ]` line that appears below
 * that heading.  Returns null when there is no `## Tasks` section or no
 * unchecked item remains.
 *
 * Delegates to the shared checklist parser (`firstUnchecked`) so that
 * all PLAN.md parsing logic lives in a single module.
 */
export function currentTaskFromPlan(planMd: string): string | null {
  const selected = firstUnchecked(planMd);
  return selected ? selected.item.text : null;
}

/**
 * Read a PLAN.md file (the card's orchestrator-private plan — see
 * `planStatePath`) and extract the first unchecked task.  Returns null if
 * the file is missing, unreadable, or contains no unchecked task.
 */
export function currentTaskFromFile(planPath: string): string | null {
  try {
    if (!fs.existsSync(planPath)) return null;
    const content = fs.readFileSync(planPath, "utf-8");
    return currentTaskFromPlan(content);
  } catch {
    return null;
  }
}