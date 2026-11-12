# Live Logs — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-11-11
**Applies to:** `src/commands/logs.ts`, `src/server/projects.ts`, `src/api/types.ts`, the app's project detail and a new log screen

---

## 1. What changes

The app's "Current log" is a one-off copy of `sfo logs` output, set as
terminal text. It becomes a live activity log: a native list of what the run
is doing, updating every 2 seconds while you look at it.

## 2. Decisions

| | Decision | Why |
|---|---|---|
| Updates | **Poll every 2 s, only while a log is on screen** | Nobody watching costs nothing. Polling survives mobile networks and proxy timeouts that a long-held stream would not. |
| Where | **A live strip on the detail screen, and a full log screen** | The strip (last 3 events, while the run works) shows it is alive at a glance; tapping opens the full log. The Projects list stays calm. |
| Look | **A native list** | Rows with an icon in a tinted circle for the kind, a verb and its target (mono), agent remarks as softer quoted rows. Not terminal text. |
| History | **The live stage; earlier stages on demand** | Opens on what is happening; earlier stages are listed above it and load when tapped. Small transfers on a phone. |
| Results | **From the event stream itself** | A command row gets ✓ or ✕ when its result arrives (the stream marks errors); a failure shows its first line in red. No parsing of test output. |
| Parsing | **On the control plane, with `sfo logs`' own reader** | The control plane reads the raw log from the Sprite (`tail -c`) and turns it into events. Sprites need nothing new, so ones running an older `sfo` get live logs too. |

## 3. The list

- **Stage header:** the stage's name (`Research`, `Build · S-02`), and its
  cost once it has finished.
- **Rows by kind:** Reading, Editing, Writing, Running, Searching, Fetching,
  Finding; a remark from the agent (2 lines, tap to expand); Denied and
  Limit in the failed and waiting colours; Started and Finished as quiet
  dividers.
- **Collapsing:** a run of consecutive reads or finds becomes one row
  (`Reading 4 files`), tap to expand.
- **Following:** the list keeps the newest row in view while you are at the
  bottom; scrolling up stops following until you return.

## 4. API

`GET /projects/:id/log?stage=<name>&from=<byte>`

- Without `stage`: the stage written to most recently. Without `from`: the
  last 64 KB of it, from a whole line.
- Answers `{ stages: [{ name, size }], stage, from, to, events }`: every log
  (verify logs excluded) in the order written, the one read, the byte range
  read, and its events. The next call passes `from: to`.
- Reads at most 256 KB per call, and only whole lines. `stage` must be one of
  the listed logs; anything else is refused.
- A project still being set up has no logs (`stages: []`).

Events: `{ kind, text, target?, id?, ok? }` for `start`, `say`, `read`,
`edit`, `write`, `run`, `search`, `fetch`, `find`, `tool`, `denied`, `limit`,
`finish`; and `{ kind: 'result', id, ok, text? }` for a tool's result, which
the app attaches to the row with that `id`.

## 5. Build order

1. Structured events from `sfo logs`' reader (the CLI's own rendering
   unchanged), with tests.
2. The log route, with tests: stage listing, offsets, whole lines, the cap,
   refusing an unlisted stage.
3. The log list component, the full log screen, and the detail-screen strip.
4. Checked on web and the simulator against an existing project's logs.
