# Model Access — Spec

**Status:** Implemented (v1), 2026-09-27 — see §9 for where it differs from the design
**Date:** 2026-09-27
**Depends on:** `docs/RUNBOOK.md` B11

---

## 1. Why

B11 built `shotname`, a tool that can reach a model only through the Anthropic
API. The person it was built for runs everything on a Claude Max subscription
and had no API key, so the tool couldn't run for them. Nothing in the pipeline
asked how they could pay for model calls. That question was left to whether
the spec or clarify stage happened to raise it.

How you access models is a fact about the person, not about the idea. It is
decided once, up front, and every later stage reads it.

## 2. Profile

`<projectsRoot>/profile.json` is created the first time you run `sfo new`, and
changed with `sfo profile`.

```json
{
  "modelAccess": ["claude_subscription", "anthropic_api_key"],
  "apiKey": { "source": "keychain", "service": "anthropic-api-key" },
  "sfoPrefers": "claude_subscription",
  "fallbackToApiKey": false,
  "updatedAt": "…"
}
```

- `modelAccess` lists what you **have**, not which one to use. The values are
  an enum:
  `anthropic_api_key | claude_subscription | ollama | openai_api_key | gemini_api_key`.
  The enum covers every method on the roadmap now, so adding a backend later
  doesn't change the schema. v1 asks only about the first two (§6).
- `apiKey` is a *reference* to the key, never the key itself:
  `{source:"env", var:"ANTHROPIC_API_KEY"}` or
  `{source:"keychain", service}`. Keychain is the default suggestion, because
  an exported variable leaks into every child process (§4.1).
- `sfoPrefers` is `claude_subscription` by default whenever a subscription is
  listed.
- `fallbackToApiKey` defaults to false (§4.2).
- The profile is per person, which is what makes sfo multi-user: each user's
  `SFO_HOME` holds their own profile.

**First-run prompt**, in `sfo new`, shown only when there's no profile. It
asks which of the two v1 methods you have, then where the key lives if you
have one. If you're asked for a key reference and there's no working key
behind it, the prompt says so and saves nothing. That check is a free
`count_tokens` call, or just confirming the key is present if the network is
down.

## 3. Per-project snapshot

`sfo new --access <methods>` overrides the profile for one project. Either way,
`sfo new` writes `.sfo/ACCESS.json` with `modelAccess` and `sfoPrefers`, and
no key reference. It's committed with the project's other artifacts. Stages
read the snapshot, not the profile, so changing the profile later doesn't
rewrite an existing project's design halfway through.

## 4. sfo's own runs

### 4.1 Choosing credentials

`ClaudeCodeRunner` builds the child environment from `ACCESS.json` and the
profile, instead of passing `process.env` straight through:

| Resolved method | Child env |
|---|---|
| `claude_subscription` | `ANTHROPIC_API_KEY` **removed**, so `claude` uses its own login |
| `anthropic_api_key` | `ANTHROPIC_API_KEY` set from the profile's reference |

The removal is the important half. Today an `ANTHROPIC_API_KEY` in your shell
silently moves every stage onto billed API usage, because Claude Code prefers
the variable to its login. Triage in `sfo new` already switches paths on the
same variable. It moves under the same rule: API-key triage only when the
resolved method is the key.

### 4.2 Resolving and falling back

- The method is `sfoPrefers` if it's in the project's `modelAccess`, and
  otherwise the first one listed.
- **A subscription usage limit parks the project; it doesn't silently switch
  to the key.** Detect the limit error in the stream-json result. Park as
  `{ park: "access"; stage; limit: "subscription"; resetsAt? }`, and have
  `sfo status` show `Max limit reached — resets <time>, or \`sfo run <id> --use-api-key\``.
  Moving from plan limits to real money is exactly the kind of cost decision
  that has to be put in front of the person. `fallbackToApiKey: true` in the
  profile turns this into an automatic switch, which is then logged.
- `sfo run --use-api-key` makes that one run use the key.

### 4.3 What the money figures mean

`COST.jsonl` records gain `billing: "api" | "plan"`. A plan-billed record's
`costUsd` is the API-equivalent figure `claude` reports, not a charge.
`sfo cost` and `sfo budget` label the two separately, for example
`$41.20 billed · $58.59 API-equivalent (Max plan)`. A budget ceiling applies
to the total unless `sfo budget <id> <usd> --billed-only` says otherwise.

## 5. Tools sfo builds

### 5.1 The rule

If the tool calls a model, it has a backend for every method in the project's
`ACCESS.json` that sfo can build in this version. At runtime it picks the first
one available, in a fixed order: API key, then subscription, then local, then
other providers. `--backend <name>` forces one. If none is available, it stops
before doing any work and lists what it looked for. `shotname` already behaves
this way for a missing key.

The order is the reverse of sfo's own preference, deliberately. For a tool,
the key unlocks the Batch API at half price and needs no CLI installed. For
sfo, the subscription is already paid for.

### 5.2 Where it enters the pipeline

- `spec.md` reads `ACCESS.json`. When the idea needs a model, the spec lists
  the backends to build as a requirement, not a design choice. Each backend
  gets its own acceptance criterion, including "a missing credential fails
  before any file is read".
- `clarify.md` never asks about model access again, because the profile
  already answered it.
- `deliver.md` states in `SUMMARY.md` which backends exist, and whether each
  one was exercised against the real service or only against a test double.

### 5.3 The v1 roadmap

| Version | Built tools | sfo's own runs |
|---|---|---|
| **v1** | `anthropic_api_key` only | subscription or API key |
| v2 | + `claude_subscription` (shell out to `claude -p`) | unchanged |
| later | + `ollama`, then other providers | unchanged |

In v1, when the project's `modelAccess` doesn't include
`anthropic_api_key` and the idea needs a model, `spec` records a blocking
open question explaining that the tool will need an API key to run. The
person finds that out at clarify, not after delivery.

## 6. Commands

- `sfo profile` shows the profile, including whether the key reference
  resolves, but never the key.
- `sfo profile set access <methods>`, `sfo profile set key keychain:<service>|env:<VAR>`,
  and `sfo profile set prefers <method>`.
- `sfo new --access <methods>` overrides the profile for one project.
- `sfo run --use-api-key` uses the key for this run only.

## 7. Out of scope (v1)

- Subscription, Ollama and other-provider backends in built tools. They come
  later, as in the roadmap table in §5.3.
- Storing keys. sfo stores references and reads keys when needed.
- Sharing a profile across a team.

## 8. Tests to write

- `sfo new` with no profile runs the first-run prompt and writes the profile.
  With a profile, it doesn't prompt.
- `ACCESS.json` is written on `sfo new`, and `--access` overrides the profile.
- In subscription mode, the runner's child env has no `ANTHROPIC_API_KEY`,
  even when `process.env` has one.
- In API-key mode, the child env has the key resolved from an `env:` reference
  and from a stubbed `keychain:` reference.
- Triage uses the API path only when the resolved method is the key.
- A subscription-limit result parks with `park: "access"`, and
  `fallbackToApiKey: true` switches automatically and logs it.
- `COST.jsonl` records carry `billing`, and `sfo cost` shows the two totals
  separately.
- `sfo profile` never prints the key.
- `spec.md` includes the access snapshot. With no API key in the snapshot, a
  model-calling idea gets the blocking question.

## 9. As built

Where the implementation departs from the text above:

- **The key check at setup confirms the key is there, but never calls the
  API.** `sfo profile setup` and `sfo profile set key` refuse a reference that
  resolves to nothing, but don't spend a request proving the key works. A
  revoked key surfaces at the first stage that uses it.
- **The limit park is `{ park: "limit"; stage; limit }`**, not `"access"`. It
  is recorded in `.sfo/LIMIT.json`, which `sfo status` reads and the next run
  clears when it starts. Detection reads the CLI's own stream-json
  `rate_limit_event` (`rate_limit_info.status === "rejected"`, with `resetsAt`
  in epoch seconds and `rateLimitType`), checked only on a failed run. If no
  event was emitted, it falls back to matching "usage limit reached" or "hit
  your limit" in the result text. B11's logs held 67 of these events, all
  `allowed`, which confirms that run used the plan.
- **A limit park rolls `currentStage` back to the last finished stage**, the
  same way a budget park does, so the next run repeats the interrupted stage
  instead of skipping it. Mid-build, the slice's code stays in the tree and
  its attempt isn't counted.
- **The fallback is a runner wrapper** (`FallbackRunner`). The orchestrator
  never learns about the switch. The interrupted attempt's usage is recorded
  as a failed run of that stage.
- **No `--backend` flag in built tools yet.** With one backend in v1 there's
  nothing to choose between. It comes with the second backend.
- **Projects with no `ACCESS.json`** use the profile. A person with neither
  gets `inherit`, which is the old behaviour: the child gets the shell's
  environment, and cost records carry no `billing`.
