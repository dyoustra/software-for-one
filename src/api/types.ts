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

/** One thing a run did, read from its stage log (LIVE_LOGS_SPEC §4). */
export type LogEvent =
  | { kind: "start"; text: string }
  | { kind: "finish"; ok: boolean; costUsd?: number; turns?: number; durationMs?: number }
  | { kind: "say"; text: string }
  | { kind: "read" | "edit" | "write" | "run" | "search" | "fetch" | "find" | "tool"; target: string; id?: string; tool?: string }
  /** A tool's result, for the row with the same `id`; `text` is the first of an error's lines. */
  | { kind: "result"; id?: string; ok: boolean; text?: string }
  | { kind: "denied"; target: string; text: string }
  | { kind: "limit"; text: string }
  /** A line that was not an event, such as sfo's own output. */
  | { kind: "note"; text: string };

export interface LogPage {
  /** Every stage log, in the order written. */
  stages: { name: string; size: number }[];
  /** The log read, or null when there are none yet. */
  stage: string | null;
  /** The byte range read; the next page starts at `to`. */
  from: number;
  to: number;
  events: LogEvent[];
}

/** A finished project's delivery (RESULTS_SPEC §3), as the deliver stage wrote it. */
export interface Delivery {
  what: string;
  use: ({ kind: "command"; command: string; label?: string } | { kind: "url"; url: string; label?: string } | { kind: "step"; text: string })[];
  examples: { say: string; do: string }[];
  features: string[];
  gaps: { text: string; weight: "blocks" | "limits" | "note" }[];
}

/** Research's verdict on what already exists. */
export interface PriorArt {
  verdict: "no_gap" | "marginal_gap" | "clear_gap";
  summary: string;
  existing: { name: string; url: string; gap: string }[];
  recommendation?: string | null;
}

/** What a project produced, for the done, Cost and Slices screens (RESULTS_SPEC §4). */
export interface ProjectResults {
  /** What research found already exists; a verdict other than clear_gap stops the run for the person. */
  priorArt: PriorArt | null;
  /** Null for a project delivered before DELIVERY.json, or not yet delivered. */
  delivery: Delivery | null;
  /** Commands sfo put on the person's PATH. */
  installed: string[];
  /** The criteria's groups, standing in for features when there is no delivery. */
  featuresFallback: string[];
  cost: {
    totalUsd: number;
    computeMs: number;
    byStage: { stage: string; costUsd: number; computeMs: number; ok: boolean; billing: "api" | "plan" | null }[];
  };
  slices: { id: string; name: string; criteria: string[]; attempts: number; result: "passed" | "failed" | "skipped" | "pending" }[];
}

