/**
 * Recovering the real path out of a `diff --git` header.
 *
 * Git writes the header as `a/<path> b/<path>`, but C-quotes both sides the
 * moment either path contains a byte it will not print raw — a `"`, a `\`, a
 * control character, or (unless `core.quotePath=false`) anything non-ASCII:
 *
 *     diff --git "a/src/server/sandbox/caf\303\251.ts" "b/src/server/sandbox/caf\303\251.ts"
 *
 * That matters well beyond cosmetics. `classifySensitivePaths` and
 * `classifySelfModifying` decide whether the review page raises its
 * containment and self-modifying banners by prefix-matching these paths, so a
 * header that does not parse is a security banner that does not fire.
 * `core.quotePath=false` on the diff command covers the non-ASCII case, but
 * git still quotes a `"`, a `\` or a control character regardless of it — so
 * the parsing has to hold up on its own.
 */

/** Git's `unquote_c_style` escapes, minus the octal runs handled separately. */
const ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d,
  '"': 0x22, "\\": 0x5c,
};

/**
 * Decode one C-quoted path. Bytes are collected first and decoded as UTF-8 at
 * the end, because a single character can arrive as several octal escapes
 * (`\303\251` is one `é`) and decoding them one at a time would produce
 * mojibake rather than the path.
 */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      bytes.push(...encoder.encode(body[i]));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next in ESCAPES) {
      bytes.push(ESCAPES[next]);
    } else if (next >= "0" && next <= "7") {
      bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff);
      i += 2;
    } else {
      // Not an escape git produces. Keep the character rather than dropping
      // it, so an unparseable path still shows the reviewer something real.
      bytes.push(...encoder.encode(next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Index of the `"` closing the quoted run that starts at 0, or -1. */
function closingQuote(value: string): number {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === "\\") { i += 1; continue; }
    if (value[i] === '"') return i;
  }
  return -1;
}

/**
 * The path a `diff --git` line is about — its pre-image (`a/`) side, which is
 * what the review page keys its file list and its banners off.
 *
 * Falls back to the whole line when nothing parses, which is what the old
 * inline regex did on every quoted header; that at least shows the reviewer
 * the raw line instead of an empty file entry.
 */
export function diffHeaderPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    if (end !== -1) {
      const unquoted = unquoteGitPath(rest.slice(0, end + 1));
      if (unquoted.startsWith("a/")) return unquoted.slice(2);
    }
  }
  // Unquoted. `(.*)` is greedy and backtracks to the LAST " b/", so a path
  // containing a space still resolves.
  const match = /^a\/(.*) b\/.*$/.exec(rest);
  return match ? match[1] : line;
}
