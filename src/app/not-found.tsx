import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4">
      <h2 className="text-xl font-semibold">Not Found</h2>
      <p className="text-foreground/70">Could not find the requested resource</p>
      <Link
        href="/"
        className="px-4 py-2 bg-foreground text-background rounded-md hover:opacity-90"
      >
        Go home
      </Link>
    </div>
  );
}