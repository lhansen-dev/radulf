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

  // Single line, no newlines
  const singleLine = raw.replace(/\n/g, " ").trim();
  if (singleLine.length <= 120) return singleLine;
  return singleLine.slice(0, 120) + "…";
}