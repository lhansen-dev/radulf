export type BarDatum = { label: string; value: number };

export function BarList({
  data,
  format,
}: {
  data: BarDatum[];
  /** Render the trailing value — defaults to the raw number. */
  format?: (value: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={i} className="grid min-w-0 grid-cols-[minmax(4rem,7rem)_minmax(2rem,1fr)_auto] items-center gap-2 sm:gap-3">
          <span className="truncate text-xs text-foreground/70 sm:text-sm" title={d.label}>
            {d.label}
          </span>
          <div className="flex-1 h-5 bg-foreground/[0.06] rounded overflow-hidden">
            <div
              className="h-full bg-amber-500/70 rounded"
              style={{ width: `${(d.value / max) * 100}%` }}
            />
          </div>
          <span className="shrink-0 text-right text-xs tabular-nums text-foreground/70 sm:text-sm">
            {format ? format(d.value) : d.value}
          </span>
        </div>
      ))}
    </div>
  );
}
