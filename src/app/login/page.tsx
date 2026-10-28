/** What the login route sends a browser back here with (`?error=`), as a
 * sentence. An unknown reason shows nothing: the query is anyone's to type. */
const REFUSALS: Record<string, string> = {
  invalid: "That password is not right. Try again.",
  "rate-limited": "Too many attempts. Wait a minute, then try again.",
  busy: "Too many sign-in attempts are in progress. Try again shortly.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const refusal = typeof error === "string" ? REFUSALS[error] : undefined;
  return (
    <div className="flex items-center justify-center min-h-screen">
      <form
        method="post"
        action="/api/auth/login"
        className="flex flex-col items-center gap-4 p-8 bg-surface rounded-lg shadow-lg"
      >
        <h1 className="text-2xl font-semibold">Radulf</h1>
        <p className="text-sm text-foreground/60">
          Enter the password to sign in
        </p>
        {refusal && (
          <p role="alert" className="w-64 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {refusal}
          </p>
        )}
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          required
          className="w-64 px-3 py-2 border border-foreground/20 rounded text-sm bg-foreground/5 focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          type="submit"
          className="w-64 px-3 py-2 bg-accent-strong text-on-accent rounded text-sm font-medium hover:bg-accent transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
