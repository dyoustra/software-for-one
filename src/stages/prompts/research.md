Read `.sfo/IDEA.md`. Research what already exists and what building this well would require.

Use web search EXTENSIVELY. Cover:
- Existing products or open-source projects that do this. Link them. Say what each gets right and where it falls short.
- The libraries or APIs a good implementation would use, with the specific reason each is the right choice.
- Known gotchas: rate limits, auth requirements, licensing, platform restrictions, anything that has bitten people building this.
- Anything that makes this harder than it looks.

**Write incrementally.** Create `.sfo/RESEARCH.md` as soon as you have your first finding and append to it as you go — do not compose the whole document in your head and write it at the end. Stages get killed mid-run by connection drops and timeouts; a stage that dies after twenty minutes of work must leave its partial findings on disk, not nothing.

Be concrete and cite sources. If the idea turns out to be well-served by something that already exists, say so plainly — that is a useful finding, not a failure.

**List the real seams.** Every external service the idea would call, and every
platform API it would rely on (OCR, a system index, the clipboard,
notifications), is a place where tests will use a fake and reality can
disagree with it. For each, find its **documented limits** — field lengths and
formats, size caps, required fields, rate limits, what it rejects — and cite the
page each one comes from. Write them to `.sfo/SERVICES.jsonl`, one object per
line:

    {"id":"anthropic-batch","name":"Anthropic Message Batches API","kind":"network",
     "effect":"billed","testMode":null,
     "credential":{"name":"ANTHROPIC_API_KEY","covers":"anthropic_api_key"},
     "constraints":[{"rule":"each request's custom_id matches ^[a-zA-Z0-9_-]{1,64}$","source":"https://docs.anthropic.com/en/api/creating-message-batches"}],
     "smoke":{"checks":["submit a one-request batch"],"maxCostUsd":0.01,"async":true}}

- `kind` is `network` or `platform`.
- `effect` is what exercising it does to the world: `read_only`, `billed`,
  `reversible` (it can be undone, and the undo can be checked), or
  `irreversible` (a sent message, a charge, a deletion). When unsure, choose the
  more dangerous label; the spec stage settles it.
- `testMode` is how the service lets you exercise it without the effect (a
  sandbox, test keys), or `null`.
- `credential.name` is the environment variable a client reads; `covers` is
  `anthropic_api_key` or `claude_subscription` when it is one of those, else
  `null`. `credential` is `null` when there is none.
- Every constraint needs a `source` URL. A rule you cannot source is a guess;
  leave it out rather than invent it. A wrong limit here becomes a fake that
  accepts what the real service rejects.
- `smoke` is the cheapest harmless check that proves the seam works for real,
  with its worst-case cost; `async` when the service answers later.

Finally, write `.sfo/PRIOR_ART.json` with your verdict:

    {"verdict":"clear_gap","summary":"<one paragraph>",
     "existing":[{"name":"<project>","url":"<link>","gap":"<what it does not do>"}],
     "recommendation":"<only when verdict is no_gap>"}

- `no_gap` — something existing already does this well enough that building it
  would be wasted effort. **`recommendation` is required**: name what to use
  instead. This stops the pipeline, so use it when you mean it.
- `marginal_gap` — the differences are real but small. This stops the pipeline
  and asks the person to decide.
- `clear_gap` — nothing existing covers this; the pipeline proceeds.

Be honest here. Concluding that an idea should not be built is a useful finding,
not a failure, and it is far cheaper to say so now than after a build.

Write only `.sfo/RESEARCH.md`, `.sfo/SERVICES.jsonl`, and `.sfo/PRIOR_ART.json`. Do not create any other files.
