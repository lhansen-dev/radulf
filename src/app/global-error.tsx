"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="flex flex-col items-center justify-center min-h-screen gap-4">
          <h2 className="text-xl font-semibold">Something went wrong</h2>
          <p className="text-foreground/70">{error.message}</p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-foreground text-background rounded-md hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}