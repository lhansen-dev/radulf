"use client";

export function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return Promise.resolve(false);
  if (Notification.permission === "granted") return Promise.resolve(true);
  return Notification.requestPermission().then((p) => p === "granted");
}

export function notificationsAvailable(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export function showCardNotification(title: string, body: string): void {
  if (!notificationsAvailable()) return;
  new Notification(title, { body });
}

export function playAlertSound(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sine";

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    // First note: 660 Hz
    osc.frequency.setValueAtTime(660, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.15);
    // Second note: 880 Hz
    osc.frequency.setValueAtTime(880, now + 0.15);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.17);
    gain.gain.linearRampToValueAtTime(0, now + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);

    osc.onended = () => ctx.close();
  } catch {
    /* ignore */
  }
}