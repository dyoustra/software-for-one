import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { Project } from '@sfo/api';
import { useAuth } from '@/lib/auth';
import { cardModel, waitingOnYou } from '@/lib/pipeline';

/** How often to look again while something is setting up or running. The list is the control plane's cache: no Sprite wakes for it. */
const WHILE_ACTIVE_MS = 10_000;

type Projects = {
  /** Null until first loaded. */
  projects: Project[] | null;
  /** Runs waiting on the person, the one waiting longest first. */
  waiting: Project[];
  error: unknown;
  refresh(): Promise<void>;
};

const ProjectsContext = createContext<Projects | null>(null);

/** The person's projects, shared by the Idea and Projects tabs and the tab badge, kept fresh while anything is in progress. */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { api, token } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api<Project[]>('/projects');
      active.current = fresh.some((p) => ['setup', 'running'].includes(cardModel(p).kind));
      setProjects(fresh);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => {
    if (!token) return;
    // refresh() sets state only after its request returns, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const timer = setInterval(() => {
      if (active.current && AppState.currentState === 'active') refresh();
    }, WHILE_ACTIVE_MS);
    const resumed = AppState.addEventListener('change', (state) => state === 'active' && refresh());
    return () => {
      clearInterval(timer);
      resumed.remove();
    };
  }, [token, refresh]);

  const value = useMemo(() => ({ projects, waiting: waitingOnYou(projects ?? []), error, refresh }), [projects, error, refresh]);
  return <ProjectsContext value={value}>{children}</ProjectsContext>;
}

export function useProjects(): Projects {
  const projects = use(ProjectsContext);
  if (!projects) throw new Error('useProjects outside ProjectsProvider');
  return projects;
}
