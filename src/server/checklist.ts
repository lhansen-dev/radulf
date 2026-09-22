/**
 * checklist.ts — shared .ralph/PLAN.md checklist parser.
 *
 * This is the ONE standalone parser for PLAN.md checklists, used by both
 * Phase 1 orchestrator bookkeeping and Phase 2 task injection.  It exposes
 * three functions:
 *
 *   parseChecklist  – parse the full checklist (never throws)
 *   firstUnchecked  – find the first unchecked item (delegates to
 *                     parseChecklist)
 *   markChecked     – flip an item from "- [ ]" to "- [x]" (byte-preserving)
 *   appendTask      – add a new unchecked item to the ## Tasks section
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChecklistItem = {
  /** Full item text; continuation lines joined with "\n", trimmed. */
  text: string;
  /** true for "- [x]" / "- [X]", false for "- [ ]". */
  checked: boolean;
  /** 1-based line index of the "- [ ]" / "- [x]" marker. */
  startLine: number;
  /** 1-based line index of the last line belonging to this item (inclusive). */
  endLine: number;
};

export type ParsedChecklist = {
  /** Items in source order; task numbers are 1-based positions in this array. */
  items: ChecklistItem[];
};

export type SelectedTask = {
  /** 1-based index of the item within ParsedChecklist.items. */
  taskNumber: number;
  item: ChecklistItem;
  /** true when no other unchecked item remains after this one. */
  isLastUnchecked: boolean;
  /** How many items the checklist holds in all, checked or not. */
  taskCount: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Regex that matches a task marker line (must start at column 0). */
const TASK_MARKER_RE = /^-\s*\[([ xX])\]\s+(.*)$/;

/** Returns true when the trimmed line is exactly `## Tasks`. */
function isTasksHeading(line: string): boolean {
  return line.trim() === "## Tasks";
}

/** Returns true when the line starts with whitespace (indented). */
function isIndented(line: string): boolean {
  return line.length > 0 && (line[0] === " " || line[0] === "\t");
}

// ---------------------------------------------------------------------------
// parseChecklist
// ---------------------------------------------------------------------------

/**
 * Parse a PLAN.md string and return a structured checklist.
 *
 * Returns `null` when the plan has no `## Tasks` heading (never throws).
 * Malformed input simply yields fewer/no items.
 */
export function parseChecklist(planMd: string): ParsedChecklist | null {
  const lines = planMd.split("\n");
  let headingIndex = -1;

  // Locate the `## Tasks` heading (trimmed line equals `## Tasks`).
  for (let i = 0; i < lines.length; i++) {
    if (isTasksHeading(lines[i])) {
      headingIndex = i;
      break;
    }
  }

  if (headingIndex === -1) {
    return null;
  }

  const items: ChecklistItem[] = [];
  let currentItem: ChecklistItem | null = null;

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const markerMatch = line.match(TASK_MARKER_RE);

    // Stop at the next `## ` heading (or any heading that starts with ##)
    if (/^##\s/.test(line.trim())) {
      break;
    }

    if (markerMatch) {
      // Start a new item
      const checked = markerMatch[1] === "x" || markerMatch[1] === "X";
      const text = markerMatch[2].trim();
      currentItem = {
        text,
        checked,
        startLine: i + 1, // 1-based
        endLine: i + 1,
      };
      items.push(currentItem);
    } else if (currentItem !== null && isIndented(line)) {
      // Continuation line: append to current item's text
      const trimmedContinuation = line.trim();
      if (trimmedContinuation.length > 0) {
        currentItem.text += "\n" + trimmedContinuation;
      }
      currentItem.endLine = i + 1;
    } else if (line.trim() === "") {
      // Blank line ends the current item's continuation block
      currentItem = null;
    } else {
      // Non-indented, non-marker line (e.g. prose) ends the item
      currentItem = null;
    }
  }

  return { items };
}

// ---------------------------------------------------------------------------
// firstUnchecked
// ---------------------------------------------------------------------------

/**
 * Return the first unchecked item, or `null` when parseChecklist returns
 * `null` or no unchecked item remains.
 */
export function firstUnchecked(planMd: string): SelectedTask | null {
  const parsed = parseChecklist(planMd);
  if (parsed === null) {
    return null;
  }

  let firstUncheckedIndex = -1;
  for (let i = 0; i < parsed.items.length; i++) {
    if (!parsed.items[i].checked) {
      firstUncheckedIndex = i;
      break;
    }
  }

  if (firstUncheckedIndex === -1) {
    return null;
  }

  // Check if any unchecked item follows this one
  let hasLaterUnchecked = false;
  for (let i = firstUncheckedIndex + 1; i < parsed.items.length; i++) {
    if (!parsed.items[i].checked) {
      hasLaterUnchecked = true;
      break;
    }
  }

  return {
    taskNumber: firstUncheckedIndex + 1, // 1-based
    item: parsed.items[firstUncheckedIndex],
    isLastUnchecked: !hasLaterUnchecked,
    taskCount: parsed.items.length,
  };
}

// ---------------------------------------------------------------------------
// markChecked
// ---------------------------------------------------------------------------

/**
 * Return `planMd` with the item at `taskNumber` (1-based) flipped from
 * "- [ ]" to "- [x]". Preserves every other byte.
 *
 * Throws when `taskNumber` is out of range or the item is already checked
 * (caller bug).
 */
export function markChecked(planMd: string, taskNumber: number): string {
  const parsed = parseChecklist(planMd);
  if (parsed === null) {
    throw new Error(
      `markChecked: cannot find item ${taskNumber} — plan has no ## Tasks section`,
    );
  }

  if (taskNumber < 1 || taskNumber > parsed.items.length) {
    throw new Error(
      `markChecked: taskNumber ${taskNumber} is out of range (1–${parsed.items.length})`,
    );
  }

  const item = parsed.items[taskNumber - 1];

  if (item.checked) {
    throw new Error(
      `markChecked: item ${taskNumber} is already checked`,
    );
  }

  const lines = planMd.split("\n");
  const markerLineIndex = item.startLine - 1; // 0-based
  const line = lines[markerLineIndex];

  // Replace the first "- [ ]" with "- [x]" (byte-preserving)
  const uncheckedMarker = "- [ ]";
  const checkedMarker = "- [x]";
  const markerPos = line.indexOf(uncheckedMarker);

  if (markerPos === -1) {
    // Should not happen given we parsed it, but be defensive
    throw new Error(
      `markChecked: cannot find "- [ ]" marker on line ${item.startLine}`,
    );
  }

  const newLine =
    line.slice(0, markerPos) + checkedMarker + line.slice(markerPos + uncheckedMarker.length);
  lines[markerLineIndex] = newLine;

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// appendTask
// ---------------------------------------------------------------------------

/**
 * Return `planMd` with a new unchecked item appended to the end of the
 * `## Tasks` section (before the next `##` heading, else at EOF).
 *
 * Every iteration runs on an injected checklist task, so a loop re-entry
 * without re-planning (a merge-conflict reloop) must add one —
 * otherwise the resumed loop dies with an exhausted checklist. Multiline
 * text becomes indented continuation lines; blank lines are dropped so the
 * item stays a single checklist entry. Throws when the plan has no
 * `## Tasks` section or the text is empty (caller bug).
 */
export function appendTask(planMd: string, text: string): string {
  const lines = planMd.split("\n");
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTasksHeading(lines[i])) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) {
    throw new Error("appendTask: plan has no ## Tasks section");
  }

  let insertAt = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      insertAt = i;
      break;
    }
  }
  // Insert directly after the section's last non-blank line.
  while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }

  const [first, ...rest] = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!first) {
    throw new Error("appendTask: task text is empty");
  }
  const item = [`- [ ] ${first}`, ...rest.map((line) => `  ${line}`)];
  return [...lines.slice(0, insertAt), ...item, ...lines.slice(insertAt)].join("\n");
}