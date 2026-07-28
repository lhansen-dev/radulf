"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  useEventStream,
  type BoardCard,
  type CardStatus,
  type ImprovementRun,
  type Repo,
} from "./api";
import { refreshTargetsForEvent } from "./eventRefresh";
import { notificationsAvailable, playAlertSound, showCardNotification } from "./notify";

export type ImprovementRunAlert = {
  featureBranch: string;
  tasksSucceeded: number;
  status: ImprovementRun["status"];
};

/** Board data, live refresh, connectivity, and notification state. */
export function useWorkData() {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [streamConnected, setStreamConnected] = useState(true);
  const [autoMode, setAutoMode] = useState(true);
  const [improvementRuns, setImprovementRuns] = useState<ImprovementRun[]>([]);
  const [improvementAlert, setImprovementAlert] = useState<ImprovementRunAlert | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const notifyPrefs = useRef({ notifications: false, sound: false });
  const previousStatuses = useRef<Map<string, CardStatus> | null>(null);

  const handleCards = useCallback((next: BoardCard[]) => {
    const nextMap = new Map<string, CardStatus>(next.map((card) => [card.id, card.status]));
    if (previousStatuses.current) {
      for (const card of next) {
        const previous = previousStatuses.current.get(card.id);
        if (
          previous &&
          previous !== card.status &&
          ["review", "plan_review", "needs_attention"].includes(card.status)
        ) {
          if (notifyPrefs.current.notifications) {
            showCardNotification("Task needs you", card.title);
          }
          if (notifyPrefs.current.sound) playAlertSound();
        }
      }
    }
    previousStatuses.current = nextMap;
    setCards(next);
    setLoading(false);
  }, []);

  const checkHealth = useCallback(() => {
    api<{ restartRequired?: boolean }>("/api/health")
      .then((result) => setRestartRequired(Boolean(result.restartRequired)))
      .catch(() => {});
  }, []);
  const refetchCards = useCallback(() => {
    api<BoardCard[]>("/api/cards")
      .then(handleCards)
      .catch((cause) => {
        setError(String(cause));
        setLoading(false);
      });
  }, [handleCards]);
  const refetchRepos = useCallback(() => {
    api<Repo[]>("/api/repos").then(setRepos).catch(() => {});
  }, []);
  const refetchSettings = useCallback(() => {
    api<{
      autoMode: boolean;
      notificationsEnabled: boolean;
      soundEnabled: boolean;
    }>("/api/settings")
      .then((settings) => {
        setAutoMode(settings.autoMode);
        notifyPrefs.current = {
          notifications: settings.notificationsEnabled,
          sound: settings.soundEnabled,
        };
      })
      .catch(() => {});
  }, []);
  const refetchImprovementRuns = useCallback(() => {
    api<{ runs: ImprovementRun[] }>("/api/improvement-runs")
      .then((result) => setImprovementRuns(result.runs))
      .catch(() => {});
  }, []);
  const refetch = useCallback(() => {
    refetchCards();
    refetchRepos();
    refetchSettings();
    checkHealth();
    refetchImprovementRuns();
  }, [checkHealth, refetchCards, refetchImprovementRuns, refetchRepos, refetchSettings]);

  useEffect(refetch, [refetch]);
  const eventTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEventStream((event) => {
    if (event.type === "improvement.completed") {
      try {
        const payload = JSON.parse(event.payload ?? "{}") as {
          featureBranch?: string;
          tasksSucceeded?: number;
          status?: ImprovementRun["status"];
        };
        if (payload.featureBranch && payload.status) {
          const alert: ImprovementRunAlert = {
            featureBranch: payload.featureBranch,
            tasksSucceeded: payload.tasksSucceeded ?? 0,
            status: payload.status,
          };
          const title =
            alert.status === "failed" ? "Improvement run failed" :
            alert.status === "stopped" ? "Improvement run stopped" :
            "Improvement run finished";
          const body = `${alert.tasksSucceeded} task${alert.tasksSucceeded === 1 ? "" : "s"} landed on ${alert.featureBranch}`;
          if (notifyPrefs.current.notifications && notificationsAvailable()) {
            showCardNotification(title, body);
          } else {
            setImprovementAlert(alert);
          }
          if (notifyPrefs.current.sound) playAlertSound();
        }
      } catch {
        // ignore malformed payload
      }
    }
    const targets = refreshTargetsForEvent(event.type);
    if (targets.includes("cards")) {
      if (eventTimer.current) clearTimeout(eventTimer.current);
      eventTimer.current = setTimeout(refetchCards, 150);
    }
    if (targets.includes("repos")) refetchRepos();
    if (targets.includes("improvementRuns")) refetchImprovementRuns();
  }, setStreamConnected);

  useEffect(() => {
    const interval = setInterval(() => {
      setCards((current) => [...current]);
      checkHealth();
    }, 30_000);
    const offline = () => setStreamConnected(false);
    const online = () => {
      setStreamConnected(true);
      refetch();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      clearInterval(interval);
      if (eventTimer.current) clearTimeout(eventTimer.current);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [checkHealth, refetch]);

  return {
    cards,
    setCards,
    repos,
    error,
    setError,
    loading,
    streamConnected,
    autoMode,
    setAutoMode,
    improvementRuns,
    improvementAlert,
    dismissImprovementAlert: () => setImprovementAlert(null),
    restartRequired,
    restarting,
    setRestarting,
    refetch,
  };
}
