# AGENTS.md

ChatGPT Conversation Exporter — an experimental tool for exporting your own
ChatGPT data via the unofficial backend API. See [`README.md`](README.md),
[`SPECIFICATION.md`](SPECIFICATION.md), and [`TODO.md`](TODO.md) for project
detail and caveats.

## Operators: start here

**If you've been named an operator** — i.e. you are driving striatum workflows
against this repository, not just editing its files — do not improvise a cold
start. Run the striatum operator initialization first:

```bash
striatum operator bootstrap --markdown
```

Then follow the returned `next_actions` and bounded `reading_plan` before
opening broad repository docs. Use `--json` instead of `--markdown` when another
tool will consume the packet. This needs the striatum daemon running and this
repository registered as a striatum target.

If you are already inside a supervised lane holding a work packet, that packet
and the installed RFC 0015 skill bundle (`.claude/skills/striatum-*/`,
`.codex/agents/striatum-*.md`, `.agy/skills/striatum-*/`, or
`striatum-STRIATUM_AGENT_GUIDE.md`) are authoritative — prefer their command
shapes over anything here. The long-form companion is
`docs/how-to/how-to-agent.md` in the striatum repo.

<!-- BEGIN PROXIMAL PLANE TRACKING -->
## Plane Tracking

This repository is represented in the local/private Plane workspace `Proximal`.

- Plane project: `Export Chatgpt` (`EXPCHA`)
- Issue tracker: Plane (`Proximal` workspace), project `Export Chatgpt` (`EXPCHA`).
- Plane URL: `https://proximal.tail0ecc2e.ts.net:10000/`
- GitHub repo: `https://github.com/halbritt/export-chatgpt`
- Use Plane work items for multi-agent planning, claims, submitted artifacts, reviews, and acceptance decisions.
- When updating Plane, include the repo, branch/worktree, `run_id`, `base_sha`, artifact links, verification evidence, and authority scope in the work item description or comments.
- Do not commit Plane API tokens. Local tokens and MCP env files live outside git under `~/.config/plane/`.
<!-- END PROXIMAL PLANE TRACKING -->
