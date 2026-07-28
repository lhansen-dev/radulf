import React from "react";

/**
 * Neutralize dangerous link schemes. This markdown comes from agent/LLM output,
 * and React does NOT sanitize `href` — a `[x](javascript:…)` link would run in
 * the authenticated session on click. Allow relative links and known-safe
 * schemes only; anything else (javascript:, data:, vbscript:, …) becomes "#".
 */
function safeHref(url: string): string {
  const scheme = url.match(/^\s*([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return url; // relative or protocol-relative — no scheme to abuse
  return /^(https?|mailto)$/i.test(scheme[1]) ? url : "#";
}

/**
 * Render inline markdown (bold, italic, code, links) into React nodes.
 *
 * Tokenizes left-to-right with code spans matched first so that `**` inside
 * a code span is not misinterpreted as bold.
 *
 * Returns plain strings and React elements — no HTML strings, so React
 * auto-escapes text. Never uses `dangerouslySetInnerHTML`.
 */
export function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let keyCounter = 0;
  let buffer = "";
  let i = 0;

  function flush() {
    if (buffer) {
      nodes.push(buffer);
      buffer = "";
    }
  }

  while (i < text.length) {
    // Code span (highest priority so `**` inside code isn't treated as bold)
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        nodes.push(
          React.createElement("code", { key: keyCounter++ }, text.slice(i + 1, close)),
        );
        i = close + 1;
        continue;
      }
    }

    // Bold **…**
    if (text[i] === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close !== -1) {
        flush();
        nodes.push(
          React.createElement("strong", { key: keyCounter++ }, text.slice(i + 2, close)),
        );
        i = close + 2;
        continue;
      }
    }

    // Italic *…* (single asterisk, not part of **)
    if (text[i] === "*" && text[i + 1] !== "*") {
      const close = text.indexOf("*", i + 1);
      if (close !== -1) {
        flush();
        nodes.push(
          React.createElement("em", { key: keyCounter++ }, text.slice(i + 1, close)),
        );
        i = close + 1;
        continue;
      }
    }

    // Link [text](url)
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const endParen = text.indexOf(")", closeBracket + 2);
        if (endParen !== -1) {
          flush();
          nodes.push(
            React.createElement("a", {
              key: keyCounter++,
              href: safeHref(text.slice(closeBracket + 2, endParen)),
              target: "_blank",
              rel: "noreferrer",
            }, text.slice(i + 1, closeBracket)),
          );
          i = endParen + 1;
          continue;
        }
      }
    }

    buffer += text[i];
    i++;
  }

  flush();
  return nodes;
}