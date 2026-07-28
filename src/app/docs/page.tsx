import { redirect } from "next/navigation";

/**
 * The wiki has no separate landing page — the doc pages already carry a full
 * sidebar of every doc, so an index would just duplicate it. Land on the first
 * Start-here doc instead.
 */
export default function DocsIndexPage() {
  redirect("/docs/what-is-radulf");
}
