import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { LogEvent, LogPage } from '@sfo/api';
import { useAuth } from '@/lib/auth';

/** How often a log on screen looks for more while the run works (LIVE_LOGS_SPEC §2). */
const POLL_MS = 2_000;

export type StageLog = { events: LogEvent[]; to: number; size: number; loading: boolean };

/**
 * A project's activity: the live stage, followed every 2 s while this screen
 * is in view and the run is `live`, and earlier stages loaded when asked for.
 * Nothing is fetched while the screen is out of view.
 */
export function useLog(projectId: string, live: boolean) {
  const { api } = useAuth();
  const [stages, setStages] = useState<LogPage['stages']>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, StageLog>>({});
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  // The poll reads these between renders.
  const at = useRef<{ stage: string | null; to: number }>({ stage: null, to: 0 });
  const busy = useRef(false);

  const take = useCallback((page: LogPage, append: boolean) => {
    setStages(page.stages);
    if (!page.stage) return;
    const name = page.stage;
    const size = page.stages.find((s) => s.name === name)?.size ?? page.to;
    setLogs((prev) => ({
      ...prev,
      [name]: { events: append ? [...(prev[name]?.events ?? []), ...page.events] : page.events, to: page.to, size, loading: false },
    }));
  }, []);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { stage, to } = at.current;
      const page = await api<LogPage>(stage ? `/projects/${projectId}/log?stage=${encodeURIComponent(stage)}&from=${to}` : `/projects/${projectId}/log`);
      const latest = page.stages.at(-1)?.name ?? null;
      if (stage && latest && latest !== stage) {
        // A new stage started: finish this one's page, then follow the new one from its start.
        take(page, true);
        const next = await api<LogPage>(`/projects/${projectId}/log?stage=${encodeURIComponent(latest)}&from=0`);
        take(next, false);
        at.current = { stage: latest, to: next.to };
        setCurrent(latest);
      } else {
        take(page, !!stage);
        at.current = { stage: page.stage, to: page.to };
        setCurrent(page.stage);
      }
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      busy.current = false;
      setLoaded(true);
    }
  }, [api, projectId, take]);

  useFocusEffect(
    useCallback(() => {
      poll();
      if (!live) return;
      const timer = setInterval(() => AppState.currentState === 'active' && poll(), POLL_MS);
      return () => clearInterval(timer);
    }, [poll, live]),
  );

  /** An earlier stage, read from its start (more of it with each call, for a long one). */
  const loadStage = useCallback(
    async (name: string) => {
      const from = logs[name]?.to ?? 0;
      setLogs((prev) => ({ ...prev, [name]: { events: prev[name]?.events ?? [], to: from, size: prev[name]?.size ?? 0, loading: true } }));
      try {
        take(await api<LogPage>(`/projects/${projectId}/log?stage=${encodeURIComponent(name)}&from=${from}`), from > 0);
      } catch (err) {
        setError(err);
        setLogs((prev) => ({ ...prev, [name]: { ...prev[name], loading: false } }));
      }
    },
    [api, projectId, logs, take],
  );

  return { stages, current, logs, loadStage, error, loaded };
}
