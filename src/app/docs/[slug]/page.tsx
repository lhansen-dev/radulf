import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "../../ui/appShell";
import { DocsNav } from "../docsNav";
import { MarkdownDoc } from "../markdownDoc";
import { getDocMeta, listDocs, readDoc } from "../../../server/docs";

export function generateStaticParams() {
  return listDocs().map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meta = getDocMeta(slug);
  if (!meta) return { title: "Docs — Radulf" };
  return { title: `${meta.title} — Docs — Radulf`, description: meta.description };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = await readDoc(slug);
  if (!doc) notFound();

  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-6xl gap-8 px-4 py-6 pb-24 sm:px-6 lg:py-10">
        {/* Sidebar — desktop only; mobile gets the "All docs" link below. */}
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-6">
            <Link
              href="/docs"
              className="mb-4 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-[0.14em] text-foreground/40 hover:text-accent"
            >
              <span aria-hidden="true">←</span> All docs
            </Link>
            <DocsNav activeSlug={doc.meta.slug} />
          </div>
        </aside>

        <article className="min-w-0 flex-1">
          <Link
            href="/docs"
            className="mb-4 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-[0.14em] text-foreground/40 hover:text-accent lg:hidden"
          >
            <span aria-hidden="true">←</span> All docs
          </Link>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-foreground/35">
            {doc.meta.group}
          </p>
          <MarkdownDoc content={doc.content} sourcePath={doc.meta.sourcePath} />

          <footer className="mt-10 border-t border-foreground/10 pt-4">
            <a
              href={`https://github.com/lhansen-dev/radulf/blob/main/${doc.meta.sourcePath}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-foreground/40 hover:text-accent"
            >
              Edit this page on GitHub → {doc.meta.sourcePath}
            </a>
          </footer>
        </article>
      </div>
    </AppShell>
  );
}
