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

export type DiffHeaderPaths = { source: string; destination: string };

/** Both identities in a `diff --git` header. Security classification must
 * consider both sides of a rename, while the destination is the primary file
 * shown to the reviewer. */
export function diffHeaderPaths(line: string): DiffHeaderPaths {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    if (end !== -1) {
      const source = unquoteGitPath(rest.slice(0, end + 1));
      const destinationPart = rest.slice(end + 1).trimStart();
      const destinationEnd = destinationPart.startsWith('"')
        ? closingQuote(destinationPart)
        : -1;
      const destination = destinationEnd === -1
        ? destinationPart
        : unquoteGitPath(destinationPart.slice(0, destinationEnd + 1));
      if (source.startsWith("a/") && destination.startsWith("b/")) {
        return { source: source.slice(2), destination: destination.slice(2) };
      }
    }
  }
  // A header for anything but a rename or copy names the same path twice.
  // A crafted rename can also produce a symmetric header, but git follows
  // every rename with unambiguous `rename from`/`rename to` lines, which
  // callers apply via `extendedHeaderPath` to override this reading.
  const same = rest.slice(2, (rest.length - 1) / 2);
  if (rest === `a/${same} b/${same}`) return { source: same, destination: same };
  // Git may leave spaces unquoted, including the exact ` b/` delimiter text
  // inside a path. The grammar is ambiguous in that case. Use the earliest
  // plausible destination marker so a sensitive destination remains whole
  // and a sensitive source prefix remains visible to classification. Picking
  // the last marker allowed a destination such as
  // `src/server/sandbox/policy b/ignored.ts` to lose its sensitive prefix.
  const candidates = [rest.indexOf(" b/"), rest.indexOf(' "b/')].filter(
    (index) => index !== -1,
  );
  const split = candidates.length > 0 ? Math.min(...candidates) : -1;
  if (split !== -1) {
    const source = rest.slice(0, split);
    const rawDestination = rest.slice(split + 1);
    const destination = rawDestination.startsWith('"')
      ? unquoteGitPath(rawDestination)
      : rawDestination;
    if (source.startsWith("a/") && destination.startsWith("b/")) {
      return { source: source.slice(2), destination: destination.slice(2) };
    }
  }
  return { source: line, destination: line };
}

const EXTENDED_HEADER = /^(rename|copy) (from|to) (.+)$/;

/**
 * The path named by a `rename from`/`rename to`/`copy from`/`copy to` line in
 * a file's extended header, or null for any other line. These carry one path
 * each, C-quoted like the header, so they are the unambiguous identities of a
 * rename whose `diff --git` header cannot be split reliably.
 */
export function extendedHeaderPath(
  line: string,
): { side: "source" | "destination"; path: string } | null {
  const match = EXTENDED_HEADER.exec(line);
  if (!match) return null;
  return {
    side: match[2] === "from" ? "source" : "destination",
    path: unquoteGitPath(match[3]),
  };
}

/** The destination path used as the primary review identity. */
export function diffHeaderPath(line: string): string {
  return diffHeaderPaths(line).destination;
}
