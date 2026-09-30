import { SETTING_DEFAULTS, type Settings } from "@/server/settings";

/**
 * A complete Settings object: SETTING_DEFAULTS with `overrides` applied.
 *
 * Importing this module loads `@/server/settings` and, through it, `@/db`,
 * which fixes DATA_DIR the moment it loads (the connection itself opens
 * lazily). A test that calls setupTestDataDir must therefore import this
 * dynamically after that call, and a test that mocks "./settings" must spread
 * `importOriginal()` into its factory so SETTING_DEFAULTS survives the mock.
 */
export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...SETTING_DEFAULTS, ...overrides };
}
