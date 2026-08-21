Read `.sfo/IDEA.md`. Research what already exists and what building this well would require.

Use web search. Cover:
- Existing products or open-source projects that do this. Link them. Say what each gets right and where it falls short.
- The libraries or APIs a good implementation would use, with the specific reason each is the right choice.
- Known gotchas: rate limits, auth requirements, licensing, platform restrictions, anything that has bitten people building this.
- Anything that makes this harder than it looks.

**Write incrementally.** Create `.sfo/RESEARCH.md` as soon as you have your first finding and append to it as you go — do not compose the whole document in your head and write it at the end. Stages get killed mid-run by connection drops and timeouts; a stage that dies after twenty minutes of work must leave its partial findings on disk, not nothing.

Be concrete and cite sources. If the idea turns out to be well-served by something that already exists, say so plainly — that is a useful finding, not a failure.

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

Write only `.sfo/RESEARCH.md` and `.sfo/PRIOR_ART.json`. Do not create any other files.
