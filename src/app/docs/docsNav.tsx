import Link from "next/link";
import { DOC_GROUPS, listDocs } from "../../server/docs";

/**
 * Grouped list of every doc, used as the wiki sidebar on a doc page. The active
 * slug is passed in from the route params (no client-side pathname needed).
 */
export function DocsNav({ activeSlug }: { activeSlug?: string }) {
  const docs = listDocs();
  return (
    <nav aria-label="Documentation" className="flex flex-col gap-5 text-sm">
      {DOC_GROUPS.map((group) => {
        const groupDocs = docs.filter((d) => d.group === group);
        if (groupDocs.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-1">
            <p className="px-2 text-[0.68rem] font-medium uppercase tracking-[0.14em] text-foreground/35">
              {group}
            </p>
            {groupDocs.map((doc) => {
              const active = doc.slug === activeSlug;
              return (
                <Link
                  key={doc.slug}
                  href={`/docs/${doc.slug}`}
                  aria-current={active ? "page" : undefined}
                  title={doc.description}
                  className={`rounded-md px-2 py-1.5 leading-snug transition-colors ${
                    active
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-foreground/60 hover:bg-foreground/5 hover:text-foreground/85"
                  }`}
                >
                  {doc.title}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
