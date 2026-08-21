Read `.sfo/IDEA.md`. Research what already exists and what building this well would require.

Use web search. Cover:
- Existing products or open-source projects that do this. Link them. Say what each gets right and where it falls short.
- The libraries or APIs a good implementation would use, with the specific reason each is the right choice.
- Known gotchas: rate limits, auth requirements, licensing, platform restrictions, anything that has bitten people building this.
- Anything that makes this harder than it looks.

**Write incrementally.** Create `.sfo/RESEARCH.md` as soon as you have your first finding and append to it as you go — do not compose the whole document in your head and write it at the end. Stages get killed mid-run by connection drops and timeouts; a stage that dies after twenty minutes of work must leave its partial findings on disk, not nothing.

Be concrete and cite sources. If the idea turns out to be well-served by something that already exists, say so plainly — that is a useful finding, not a failure.

Write only `.sfo/RESEARCH.md`. Do not create any other files.
