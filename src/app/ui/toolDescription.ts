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
    case "read":
      raw = pick("file_path", "filePath");
      break;
    case "edit":
    case "multiedit":
    case "write":
      raw = pick("file_path", "filePath");
      break;
    case "grep":
    case "glob":
      raw = pick("pattern");
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