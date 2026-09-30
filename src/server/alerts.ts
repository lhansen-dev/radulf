import { getSettings } from "./settings";
import { errorMessage } from "@/shared/errorMessage";

/**
 * Getting one event off this machine.
 *
 * Spec 18 §5. Radulf's other alerting is the browser Notification API raised
 * from `useWorkData.ts`, which reaches an operator exactly when a tab is
 * already open on the right machine. The card that prompted this sat in Needs
 * Attention for 86 minutes because nobody had one.
 *
 * Callers: the stale sweep this was written for, the two card statuses that
 * wait on a human the moment they are reached, and an improvement run ending.
 * Everything past the sweep is opt-out per type — see the `alertOn*` settings.
 *
 * Deliberately a bare webhook rather than an integration: one POST of the same
 * JSON the event stream already carries, which ntfy, Slack's incoming hooks,
 * Discord and a three-line handler of your own all accept.
 */

/** Long enough for a slow hook, short enough that nothing waits on it. */
const ALERT_TIMEOUT_MS = 5_000;

export type Alert = {
  type: string;
  /** Absent on an alert that is not about one card — an improvement run ending
   * is about its feature branch, and may have landed any number of cards. */
  cardId?: string;
  title: string;
  message: string;
  url?: string;
};

/** Whether anything would be sent at all, so a caller can skip building an
 * alert — and the title lookup behind it — when no webhook is configured. */
export function alertWebhookConfigured(): boolean {
  return getSettings().alertWebhookUrl.trim() !== "";
}

/**
 * Fire-and-forget. A failed alert is logged and dropped: the event is already
 * durable in the `events` table, and nothing in the pipeline may block or fail
 * because a webhook is down.
 */
export async function postAlert(alert: Alert): Promise<void> {
  const url = getSettings().alertWebhookUrl.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`alert webhook failed: ${errorMessage(e)}`);
  }
}
