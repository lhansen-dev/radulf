/** Radulf's agent env (agentEnv in src/server/harness/types.ts) sets GIT_SSH_COMMAND=/bin/false for every sandboxed run, and nothing on a plain dev host or CI does. Inside that sandbox a nested sandbox cannot start, so the real-runtime suites skip themselves with this as the signal.
 *
 * srt itself re-exports GIT_SSH_COMMAND (its socat ProxyCommand) on top of the agent env when network policy is on, so the /bin/false value may not survive into the sandboxed shell. srt unconditionally exports SANDBOX_RUNTIME=1 into every sandboxed command (sandbox-utils.js getSandboxedEnvVars), so that is checked as well. */
export const insideRadulfSandbox: boolean =
  process.env.GIT_SSH_COMMAND === "/bin/false" || process.env.SANDBOX_RUNTIME === "1";
