# Structured Preferences — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-10-04
**Replaces:** the free-text `~/.sfo/PREFERENCES.md` (CONTRACTS_SPEC.md §preferences)

---

## 1. What this is

The person's standing preferences, split in two:

- **`~/.sfo/preferences.json`**: the bounded choices, validated against fixed
  lists of allowed values. Never edited by hand: `sfo prefs …` or the app's
  Settings change it.
- **`~/.sfo/SFO.md`**: free text for everything that fits no field, read by every
  project the way CLAUDE.md is read by a session.

Each project snapshots both at capture (`.sfo/preferences.json`, `.sfo/SFO.md`),
so a later change does not redesign a project mid-build. Once the person is
signed in to the control plane, it holds the master copy; app and CLI edit the
same thing.

## 2. Fields

```json
{
  "languages": {
    "cli":      ["python", "go", "typescript"],
    "web":      ["typescript"],
    "mobile":   ["typescript"],
    "firmware": ["cpp"],
    "default":  ["python", "typescript"]
  },
  "webHost": "vercel",
  "webData": "browser",
  "budgetUsd": null,
  "smokeCapUsd": 2
}
```

| Field | Allowed | Meaning |
|---|---|---|
| `languages.<kind>` | an ordered list of known languages | best first. Kinds: `cli`, `web`, `mobile`, `firmware`, and `default` for anything else |
| `webHost` | `vercel` · `cloudflare` · `none` | where a web app is deployed; `none` delivers it locally |
| `webData` | `browser` · `synced` | where a web app keeps its data unless the idea needs otherwise |
| `budgetUsd` | a number, or `null` for none | the ceiling a new project starts with |
| `smokeCapUsd` | a number | what smoke checks may spend per run |

Known languages: python, typescript, javascript, go, rust, swift, kotlin, java,
cpp, c, micropython, ruby, elixir. Adding one is a code change, on purpose:
the list is what makes a typo impossible.

A short fixed list of kinds is a reversal of "no kinds registry", accepted
because nothing in sfo branches on it: it is a dictionary of the person's
tastes that spec reads as guidance, and anything that fits no kind uses
`default`.

## 3. Deviations are raised, not just recorded

A run may deviate from any preference when the idea is better served, and it
must say so where the person decides. When spec would pass over the first
ranked language (say, the idea is possible in Go but much easier in Python),
or any other field, it asks at clarify:

> "Your preference for CLIs is Go. This would be much simpler in Python
> because …. Which?" — options: the preference, the alternative, with
> tradeoffs.

The person's answer is the decision (`decided_by: human`). A deviation is only
made silently, as an agent decision, when the preference is impossible for
this idea (no Python on a microcontroller without MicroPython), and the
decision says why.

## 4. Changing them

```
sfo prefs                                  # show
sfo prefs languages cli python,go          # rank, best first
sfo prefs web-host cloudflare
sfo prefs web-data synced
sfo prefs budget 25 | none
sfo prefs smoke-cap 3
sfo prefs edit                             # SFO.md in $EDITOR
```

Each refuses a value outside its allowed list and says what is allowed.

## 5. Migration

On first use, an existing `PREFERENCES.md` becomes `SFO.md` unchanged, and
`preferences.json` is created with the defaults above. Nothing is parsed out of
the free text: the person moves a preference into a field when they want it
enforced as one.

## 6. Where it is read

- **spec**: languages and the web fields, with §3's rule; SFO.md as guidance.
- **capture**: `budgetUsd` as the new project's ceiling, unless `--budget`.
- **smoke**: `smokeCapUsd`.
- **cloud**: both files travel to the project's Sprite, as `PREFERENCES.md`
  does today.
