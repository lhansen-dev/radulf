/**
 * The identity of one package's lifecycle-script set, as the install-script
 * gate approves it: a version bump or an edited script body is a different
 * key and re-fires the gate.
 */
export function scriptKey(script: { name: string; version: string; scriptHash: string }): string {
  return `${script.name}@${script.version}#${script.scriptHash}`;
}
