# Results — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-11-11
**Applies to:** the deliver and feedback stages, `src/core/delivery.ts`, the control plane, the app's project detail, Cost and Slices screens

---

## 1. What changes

A finished project's screen shows what you got and how to use it, natively,
for any kind of project: not a long Markdown summary, and not terminal tables.
Cost and Slices become real screens.

## 2. Decisions

| | Decision | Why |
|---|---|---|
| Done screen leads with | **How to use it, a short summary, and a way to try it** | All three, in that order of weight. Not CLI-shaped: a command, a web address and plain steps are all ways to use something. |
| Short summary from | **`DELIVERY.json`, written by the deliver stage** | Structured data the app renders, not another Markdown pass to parse on a phone. `SUMMARY.md` stays, a tap away. |
| Model writes | **Only what needs judgment** | What it is, how to use it, examples, features, known gaps. Cost, time, slices, installed commands and screenshots come from sfo's own records, so they cannot drift. |
| A file that does not match the schema | **Fails the deliver stage, with the schema error as the reason** | Like any other stage's output contract; `sfo retry` reruns it with the error to fix. |
| Projects delivered before this | **Fall back to what is already structured** | The installed commands (`INSTALL.json`) and the criteria's group names stand in for how to use it and the features. `SUMMARY.md` is never parsed. |
| Cost and Slices | **Real screens** | Spend by stage as bars, with the total and how it was paid; each slice as a row with its result, attempts and the criteria it covers. |
| Copying a command | **Selectable text** for now | A copy button needs a native module (`expo-clipboard`), so it waits for the next native build. |

## 3. `DELIVERY.json`

```json
{
  "what": "A dice roller for the terminal: rolld 2d6+3 prints each roll and the total.",
  "use": [
    { "kind": "command", "command": "rolld 2d6+3", "label": "Roll dice" },
    { "kind": "url", "url": "https://…", "label": "Open it" },
    { "kind": "step", "text": "Set ANTHROPIC_API_KEY first." }
  ],
  "examples": [{ "say": "Roll with advantage", "do": "rolld 2d20" }],
  "features": ["Standard NdS+M notation", "Seeded rolls for repeatable results"],
  "gaps": [{ "text": "Nobody has seen its real terminal output yet.", "weight": "note" }]
}
```

- `what`: one sentence, at most 200 characters.
- `use`: 1–6 entries, each a `command`, `url` or `step`.
- `examples`: 0–4, each a thing to want (`say`) and how (`do`).
- `features`: 1–6 short phrases.
- `gaps`: 0–6, each with a `weight`: `blocks` (it does not do something it
  should), `limits` (it works with a limitation), `note`.

The deliver stage writes it after `SUMMARY.md`, from the same records, and the
gaps lead with what `SUMMARY.md` leads with. Feedback that changes the
project rewrites it.

## 4. API

`GET /projects/:id/results` — one read of the project's records on its Sprite
(plain shell, so any Sprite answers):

```
{
  delivery: Delivery | null,
  installed: string[],                 // commands on the person's PATH
  featuresFallback: string[],          // criteria group names, for older projects
  cost: { totalUsd, computeMs, byStage: [{ stage, costUsd, computeMs, ok, billing }] },
  slices: [{ id, name, criteria: string[], attempts, result: "passed" | "failed" | "skipped" | "pending" }]
}
```

## 5. Screens

- **Done (project detail, `done`):** what it is; How to use (commands and
  addresses in mono, selectable); Examples; What it does; Known gaps (by
  weight); Try it (the captured screenshots or output); one receipt line (cost,
  time, slices). Then Ask for a change, then rows for Summary, Decisions,
  Criteria, Slices, Cost, Activity.
- **Cost:** the total and how it was paid, then a bar per stage (cost, time).
- **Slices:** a row per slice: id, name, result, attempts, its criteria.

## 6. Build order

1. `DeliverySchema`, `readDelivery`, the deliver prompt, the check after
   deliver, feedback rewriting it; tests.
2. `/projects/:id/results`, with tests.
3. The done screen, Cost and Slices; checked on the dice project (the
   fallback path, since it was delivered before this).
