/**
 * The control plane's API, as its clients see it: the server builds these
 * and the app reads them, so a change to one fails the other's typecheck.
 * Types only — nothing here may import anything.
 */

export type CredentialKind = "claude_token" | "anthropic_api_key" | "github_installation";

/** A project as `sfo status` reports it on its Sprite. */
export interface ProjectSummary {
  id: string;
  title: string;
  currentStage: string;
  status: "running" | "awaiting_human" | "failed" | "done" | (string & {});
  /** What status would say about it, when there is more than its state. */
  note?: string;
  /** The command that moves it on, when there is one. */
  next?: string;
  slicesPassed?: string[];
  slicesFailed?: string[];
  updatedAt?: string;
  /** Slices planned; absent until the plan exists. */
  slicesTotal?: number;
  /** The planned slices' ids, in plan order. */
  sliceIds?: string[];
  /** Model spend so far, at API prices. Absent from summaries older than this field. */
  spendUsd?: number;
  /** Time the model spent working, summed over every stage. */
  computeMs?: number;
  /** Questions waiting for the person, when the run is parked on them. */
  openQuestions?: number;
  /** What a finished project delivered: the commands it installed. */
  delivered?: { commands: string[] };
  /** Where and why a failed run stopped. */
  failure?: { stage: string; reason: string };
}

export interface Project {
  id: string;
  sprite: string;
  repo: string | null;
  status: "creating" | "ready" | "destroyed";
  summary: ProjectSummary | null;
  /** While `creating`: the idea as given. */
  idea?: string;
  /** While `creating`: the step under way, or why setup failed. */
  setup?: { step: string | null; error: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface QuestionOption {
  key: string;
  label: string;
  tradeoff: string;
}

export interface Question {
  id: string;
  section: "blocking" | "preference";
  text: string;
  context?: string;
  options: QuestionOption[];
}

/** One line of the stream that creating a project answers with. */
export type CreateEvent = { progress: string } | { done: true; project: Project; started: boolean } | { error: string };

export interface Report {
  status: number;
  output: string;
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The device making the request. */
  current: boolean;
}

/** A way to sign in to an account. */
export interface Identity {
  provider: "apple" | "github";
  createdAt: string;
}

export type LanguageKind = "cli" | "web" | "mobile" | "firmware" | "default";

export interface Preferences {
  languages: Record<LanguageKind, string[]>;
  webHost: "vercel" | "cloudflare" | "none";
  webData: "browser" | "synced";
  budgetUsd: number | null;
  smokeCapUsd: number;
}

export interface PreferencesResponse {
  preferences: Preferences;
  sfoMd: string | null;
  /** The values each field allows, for a client to offer. */
  allowed: { kinds: LanguageKind[]; languages: string[]; webHosts: string[]; webData: string[] };
}
