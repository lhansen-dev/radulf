/**
 * Detect Trojan-Source-class characters in agent-authored diffs: bidi
 * control characters that can reorder how code *displays* without changing
 * how it *executes*, zero-width/formatting characters that hide content,
 * Unicode tag characters (used to smuggle invisible payloads), and a small
 * set of common homoglyphs that let an identifier look like another one.
 *
 * Pure and dependency-free so it can run both server-side (diff route) and
 * client-side (review page rendering) without pulling in React.
 */

export type SuspiciousCharKind = "bidi" | "zero-width" | "tag" | "confusable";

export type SuspiciousCharMatch = {
  index: number;
  char: string;
  codePoint: number;
  kind: SuspiciousCharKind;
  name: string;
};

const BIDI_CONTROL: Record<number, string> = {
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
};

const ZERO_WIDTH: Record<number, string> = {
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x2060: "WORD JOINER",
  0x2061: "FUNCTION APPLICATION",
  0x2062: "INVISIBLE TIMES",
  0x2063: "INVISIBLE SEPARATOR",
  0x2064: "INVISIBLE PLUS",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE (BOM)",
};

const TAG_RANGE: [number, number] = [0xe0000, 0xe007f];
const VARIATION_SELECTOR_RANGE: [number, number] = [0xfe00, 0xfe0f];

// Common Cyrillic/Greek letters that render identically (or near-identically)
// to a Latin letter — not exhaustive, but enough to catch the typical
// identifier-spoofing trick without flagging ordinary non-English text (we
// only flag these when mixed into an otherwise-Latin word, see below).
const CONFUSABLE_TO_LATIN: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", һ: "h", ԁ: "d", ԛ: "q", ѡ: "w",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Ѕ: "S", Ј: "J",
  α: "a", β: "b", ο: "o", ρ: "p", ν: "v", υ: "u",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};

function classify(codePoint: number): { kind: SuspiciousCharKind; name: string } | null {
  if (codePoint in BIDI_CONTROL) return { kind: "bidi", name: BIDI_CONTROL[codePoint] };
  if (codePoint in ZERO_WIDTH) return { kind: "zero-width", name: ZERO_WIDTH[codePoint] };
  if (codePoint >= TAG_RANGE[0] && codePoint <= TAG_RANGE[1]) return { kind: "tag", name: "UNICODE TAG" };
  if (codePoint >= VARIATION_SELECTOR_RANGE[0] && codePoint <= VARIATION_SELECTOR_RANGE[1])
    return { kind: "zero-width", name: "VARIATION SELECTOR" };
  return null;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** Confusable homoglyphs only get flagged inside a word that also contains
 * plain ASCII letters — a word entirely in Cyrillic/Greek is just text in
 * another script, not a spoofing attempt. */
function findConfusablesInLine(line: string): SuspiciousCharMatch[] {
  const matches: SuspiciousCharMatch[] = [];
  for (const wordMatch of line.matchAll(WORD_RE)) {
    const word = wordMatch[0];
    const hasAscii = /[a-zA-Z]/.test(word);
    if (!hasAscii) continue;
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      const latin = CONFUSABLE_TO_LATIN[ch];
      if (!latin) continue;
      matches.push({
        index: (wordMatch.index ?? 0) + i,
        char: ch,
        codePoint: ch.codePointAt(0)!,
        kind: "confusable",
        name: `looks like "${latin}"`,
      });
    }
  }
  return matches;
}

/** Scan a single line for bidi/zero-width/tag characters and confusable
 * homoglyphs, sorted left to right. */
export function findSuspiciousChars(line: string): SuspiciousCharMatch[] {
  const matches: SuspiciousCharMatch[] = [];
  for (let i = 0; i < line.length; i++) {
    const codePoint = line.codePointAt(i)!;
    const info = classify(codePoint);
    if (info) matches.push({ index: i, char: line[i], codePoint, ...info });
    if (codePoint > 0xffff) i++; // surrogate pair
  }
  matches.push(...findConfusablesInLine(line));
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

function codePointLabel(m: SuspiciousCharMatch): string {
  return `${m.name} (U+${m.codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
}

export type DiffLineSegment =
  | { kind: "text"; value: string }
  | { kind: "suspicious"; raw: string; label: string };

/** Split a diff line into plain-text and suspicious-character segments, so a
 * renderer can show suspicious characters as visible escapes instead of
 * letting them silently reorder or hide the surrounding text. */
export function segmentSuspiciousChars(line: string): DiffLineSegment[] {
  const matches = findSuspiciousChars(line);
  if (matches.length === 0) return [{ kind: "text", value: line }];
  const segments: DiffLineSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.index < cursor) continue; // overlapping match (shouldn't happen, be defensive)
    if (m.index > cursor) segments.push({ kind: "text", value: line.slice(cursor, m.index) });
    segments.push({ kind: "suspicious", raw: m.char, label: codePointLabel(m) });
    cursor = m.index + m.char.length;
  }
  if (cursor < line.length) segments.push({ kind: "text", value: line.slice(cursor) });
  return segments;
}

export function hasSuspiciousChars(text: string): boolean {
  return findSuspiciousChars(text).length > 0;
}
