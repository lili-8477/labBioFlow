# /memory — distill this session into long-term memory

Pin the *current chat* to long-term memory. Auto-distillation is off; this is the only path that creates `session_summary` / `observation` / `feedback` rows. Run it when the user explicitly asks (`/memory`), not preemptively.

## Procedure

1. Review the current conversation. Identify what's worth recalling later. Skip operational noise (file listings, command echoes, retries, transient errors).
2. Build a single distill payload matching the schema below. Be terse. Keep `body` lengths under the caps.
3. Call the MCP tool `memory_distill_session` (server: `bioflow-memory`) **once** with that payload. Do not call it multiple times — each invocation creates rows; repeats produce duplicates that are only suppressed by content hash.
4. Report the returned `attempted` count in one line so the user can confirm.

## Payload schema

```json
{
  "summary": {
    "name":        "<≤80c — what this session was about>",
    "description": "<≤200c — one sentence>",
    "body":        "<≤1500c — the gist: goal, outcome, anything load-bearing for next time>"
  },
  "observations": [
    {
      "type":        "decision | finding | file-touched | command-result | user-preference",
      "name":        "<≤80c>",
      "description": "<≤200c>",
      "body":        "<≤800c>",
      "facets":      { "gene": [], "dataset": [], "tool": [], "pipeline": [], "file": [] }
    }
  ]
}
```

Up to 8 observations. Empty `observations: []` is fine if nothing stood out.

## Type guidance

- `decision` — a chosen approach with the why; not what was tried and discarded.
- `finding` — a surprising fact learned (data shape, bug root cause, env quirk).
- `file-touched` — a path + one-line summary of what changed and why. Put the path in `facets.file`.
- `command-result` — a command whose result the user is likely to need again (path-to-output, key number, error fingerprint).
- `user-preference` — something the user expressed about how they want the agent to work.

## Optional fields

- `project_dir` — set if the session was scoped to one project (encoded form, e.g. `-home-li86-myproj`). Omit for a user-scope distill.
- `source_session_id` — omit; the agent doesn't reliably know its own session UUID.

Do not write any other memory rows (don't call `memory_write` to "supplement"); the distill payload is the single source of truth for this turn.
