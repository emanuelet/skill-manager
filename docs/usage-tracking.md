# Internal usage and search tracking

Skill Manager reads local agent histories directly. No `skilled` executable, subprocess,
network access, or telemetry service is required. The normalized ledger is in
`~/.skill-manager/search.sqlite`, alongside the search index. Only skill identifiers,
invocation timestamps, session/project identifiers, source/client names, and MCP search
queries/results are retained; conversation text and skill bodies are not stored.

## Agent extraction

The extraction rules were researched from [av/skilled](https://github.com/av/skilled),
revision `736dcccb46697d3e261ec83ca340168efc575d7c` (upstream declares MIT licensing).
The implementation here uses Node.js streams and `node:sqlite`, independently of
upstream's Bun/Rust executables. Upstream provider references:

- [Claude Code](https://github.com/av/skilled/blob/736dcccb46697d3e261ec83ca340168efc575d7c/src/providers/claude-code.ts):
  `~/.claude/history.jsonl` slash commands and `projects/**/*.jsonl` Skill-tool calls.
  Session tool calls take precedence over slash-command evidence for the same skill/session.
- [OpenCode](https://github.com/av/skilled/blob/736dcccb46697d3e261ec83ca340168efc575d7c/src/providers/opencode.ts):
  completed native `skill` calls in the local SQLite session database.
- [Codex](https://github.com/av/skilled/blob/736dcccb46697d3e261ec83ca340168efc575d7c/src/providers/codex.ts):
  `<skill><name>…</name>…</skill>` blocks in session and archived-session JSONL.
- [Droid](https://github.com/av/skilled/blob/736dcccb46697d3e261ec83ca340168efc575d7c/src/providers/droid.ts):
  `Skill "…" is now active` tool results in `~/.factory/sessions`.
- [Grok](https://github.com/av/skilled/blob/736dcccb46697d3e261ec83ca340168efc575d7c/src/providers/grok.ts):
  command tags and `read_file` loads of `skills/<name>/SKILL.md` in session traces.

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, and `OPENCODE_DB` are respected.
`SM_TEST_HOME` isolates all providers for tests. Unchanged JSONL files are skipped;
changed files are streamed again so session headers and incomplete tails are recovered.
Stable invocation IDs make repeated collection idempotent. OpenCode's mutable tool rows
are read through a read-only SQLite connection, including its WAL.

Missing providers and collection errors are reported independently. Prior event data
survives a failed refresh. Existing aggregate rows and skill metadata remain fallbacks
when a skill has no event-backed history; they are not added to observed loads.

## MCP loads and historical backfill

A successful `get_skill` with content records one load. Metadata-only disclosure,
failed reads, searches, and listings do not count as skill loads. Each invocation has
its own correlation identity; re-reading that identity deduplicates stored observations,
while reuse of a JSON-RPC request ID cannot suppress a new load. Client names are retained where supplied.
Project identity is unknown for live MCP loads; server cwd is never treated as the
agent's project.

OpenCode, Claude Code, and Codex historical skill-manager MCP loads are recognized
only when a successful result has the expected skill-manager payload. Content-bearing
responses now include a `usage_event_id`; live writes and historical extraction use
that same identity. Collection can recover a failed live write without counting
already-recorded loads twice, and can enrich a live event with its observed project.
Older responses without an ID retain stable source invocation identities. Native skill
calls continue to be collected. History formats without enough evidence are not guessed.

Counts measure observed invocation/content-loading, not successful task completion.
Grok chat-history fallbacks use a validated UUIDv7 session timestamp where no event
timestamp exists; that timestamp is approximate. Authoritative update observations
replace per-skill/session fallback observations when available.

## Search outcomes

Every successful MCP `search_skills` records its exact query, ranked returned slugs,
timestamp, client, and MCP session. Empty searches are retained. A later successful
content load selects the **most recent matching search in that same session**.
Each search is selected at most once; unrelated or metadata-only loads do not select it.
No observed selection is not evidence of task failure.

For stdio, the session is the server connection/process lifetime, not an inferred
agent conversation. Persistent proxies can reuse a connection across conversations.
There is no inferred project or cross-connection attribution.

```sh
sm analytics                     # managed skill counts and observed source breakdown
sm analytics --searches           # query → selection report
sm analytics --searches --json    # totals and latest 100 searches
sm analytics --recommend          # local project/global recommendation queries
```

The MCP `get_analytics` result includes `searches`, `sources`, and `collectors`.
Plain `sm analytics --json` retains its existing stats-array format. Analytics are
queried directly from the local ledger; the former two-minute file cache is no longer
used, so live MCP activity is visible immediately.
