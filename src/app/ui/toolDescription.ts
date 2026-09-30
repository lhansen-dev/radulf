/** Return a short human-readable description of a tool call. */
export function describeToolCall(name: string, input: unknown): string {
  const n = String(name ?? "").toLowerCase();

  if (input === null || input === undefined || typeof input !== "object") {
    return "";
  }
  const obj = input as Record<string, unknown>;

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };

  let raw: string;
  switch (n) {
    case "bash":
      raw = pick("command");
      break;
    // pi's file tools (harness/pi.ts) take `path`; the other spellings are
    // what older transcripts carry.
    case "read":
      raw = pick("path", "file_path", "filePath");
      break;
    case "edit":
    case "multiedit":
    case "write":
      raw = pick("path", "file_path", "filePath");
      break;
    case "grep":
    case "glob":
      raw = pick("pattern");
      break;
    // pi's read-only browse set (harness/pi.ts): find takes a glob and an
    // optional root, ls a directory, web_search a query.
    case "find":
      raw = pick("pattern", "path");
      break;
    case "ls":
      raw = pick("path");
      break;
    case "web_search":
      raw = pick("query");
      break;
    case "webfetch":
      raw = pick("url");
      break;
    case "task":
      raw = pick("description", "subject");
      break;
    default:
      return "";
  }

  if (raw.length === 0) return "";
  return previewLine(raw);
}

/** One line of at most 120 characters: the budget a collapsed transcript
 * row gets for a tool call's summary or a reasoning block's preview. */
export function previewLine(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= 120 ? singleLine : singleLine.slice(0, 120) + "…";
}