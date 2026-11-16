# Model Control — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-11-16
**Applies to:** preferences, the runner, cost records, the control plane, the app (Settings, project screen, Cost)

---

## 1. What changes

Today every stage runs on Claude Code's default model, and triage is pinned to
Opus. Now the person chooses, by stage group and stage, in their defaults and
per project.

## 2. Decisions

| | Decision | Why |
|---|---|---|
| What is chosen | **A model family: Haiku, Sonnet or Opus** | The names people know. sfo passes the family's alias (`--model opus`), which always means its newest release, so Opus 5.5 becomes 5.6 by itself. The exact model that ran is read from each stage's log and kept with its cost, so it is always known. |
| Groups | **Thinking, Building, Writing; a stage can override its group** | Thinking: triage, research, spec, plan, review, rulings on disputed tests. Building: writing and setting up tests, building slices, smoke checks, feedback, and repairs. Writing: questions to the person, the delivery. |
| Defaults | **Thinking: Opus. Building: Opus. Writing: Sonnet.** | |
| Where set | **Your defaults in Settings; any project can override them** | A project keeps the defaults it started with (its preferences snapshot), as with every other preference: changing your defaults affects new projects, and a project's own override affects only it. |
| Escalation | **A retry runs one family up**, on by default, switchable in your defaults and per project | First tries stay cheap; the hard parts get the stronger model. Opus stays Opus. |

## 3. Data

`preferences.json` gains:

```json
"models": { "thinking": "opus", "building": "opus", "writing": "sonnet", "stages": { "deliver": "haiku" }, "escalate": true }
```

Older preference files read with these defaults. A project's copy is its
`.sfo/PREFERENCES.json`; `sfo models <id>` shows it and `--set` changes it.
`COST.jsonl` records gain `model`, the exact model that ran.

## 4. Surfaces

- **CLI:** `sfo prefs models <group|stage> <family>`, `sfo prefs models escalate on|off`; `sfo models <id> [--set <json|->]`.
- **Control plane:** `GET`/`PUT /projects/:id/models`.
- **App:** Settings → Models (a choice per group, escalation, per-stage choices behind "Choose by stage"); a project's Models screen with the same controls for it alone; Cost shows the model each stage ran on.
