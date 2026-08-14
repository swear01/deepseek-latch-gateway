# BEGIN agents_rule-base
# Agent Rules

## Core Rules

### Stay On Task
Execute ONLY what was requested. If unclear, STOP and ASK. Do NOT assume.
One task at a time. After completing the task, STOP.

### Search First, Never Guess
NEVER fabricate code, file paths, function names, or API behavior from memory.
Do NOT implement, edit, or answer from assumptions. Do NOT proceed with a "reasonable
default" when authoritative guidance is missing.

Before any action, discover what already exists:

1. **Local** — Read target files; Grep/Glob the repo; check `docs/`, README,
   `AGENTS.md`, scoped `AGENTS.md`, and relevant skills for project guidance.
2. **External** — For libraries, APIs, tools, or time-sensitive facts (versions,
   pricing, compatibility, recent changes), search the web or official docs.
   Use Context7 MCP when available. Never rely on training data alone.

First tool calls in every task MUST be discovery (Read, Grep, Glob, SemanticSearch,
WebSearch, or doc MCP) — not edits and not invented answers.

If search finds nothing authoritative, STOP and report what you searched, what you
expected, and what decision you need from the user. Do NOT guess or fill gaps yourself.

### Code Quality
Match existing code style, naming, and patterns.
No new libraries unless asked. No comments unless asked.
Keep changes minimal.

### GitHub PR Review
When the user explicitly requests GitHub PR code review, invoke the
`github-pr-review-loop` skill. A local agent review is supplementary evidence,
not a substitute for a GitHub review bot.

### No-Useless Options
When changing behavior, change it — do not keep the old behavior as an option.
Never add flags, parameters, or config options that were not explicitly requested.
If you are about to add an "option to preserve old behavior," stop: just change the behavior.

## No Silent Fallback

### Banned Behaviors
- Silently replacing a failing API/model/library/tool with another
- Returning dummy/mock/empty/default results as if valid
- Broad catch-and-continue (`except Exception`, `catch (error)`, etc.)
- Skipping tests, linters, type checks, or verifiers
- Downgrading implementation scope just to finish
- Hiding failures behind "best effort"

### Allowed Behaviors
- Retry the exact same operation once if transient
- Propose a fallback, but STOP before implementing it
- Use fallback only when explicitly approved by the user

### When Blocked, Report
1. What failed
2. Exact command/tool/API that failed
3. Relevant error output
4. Fallback considered but NOT implemented
5. Decision needed from user

## Learn From Mistakes

When you discover that your own incorrect assumption, decision, or action caused
an error, persist the lesson during the same task if it is verified and reusable.

- Record project-specific facts and gotchas in `docs/notes.md`.
- Update the relevant active doc when the correction changes documented behavior,
  commands, APIs, configuration, or workflow.
- Change `AGENTS.md` or its managed template only when the lesson is a durable rule
  that should govern future agent behavior.
- State what was updated in the final response.
- Do not record transient failures, guesses, or secrets.

## Docs Lifecycle

- Active docs live under `docs/`.
- Historical docs live under `archive/` (mirrors original path).
- Every behavior/API/CLI/config change must update the relevant active doc
  immediately, as part of the same change — never deferred to "later".
- Obsolete docs must be archived, not left active.
- Archived docs must not be treated as current truth.
- Active docs must not link to archived docs as active references.

Before every commit, scan every doc that references or describes the changed
code/behavior and confirm it is current — fix or archive stale content. No exceptions.
Scope the scan to what the change touches; full-tree sweeps only when explicitly requested.

If no docs update is needed, explicitly report:

    Docs checked; no documentation update required.

## Archive Policy

**Archive vs Delete:**
- Archive: doc has historical value (old API, past decision, superseded design)
- Delete: doc is simply wrong, redundant, or never useful — `git rm` it directly

Do not archive to avoid decisions. Archiving inflates repo size; delete what has no value.

Use `agents_rule archive <file>` to archive docs. Do NOT manually move files.

Archive header prepended automatically:

    > Archived: YYYY-MM-DD
    > Reason: <reason>
    > Replacement: <replacement-or-none>
    > Status: historical only; do not use as active truth.

Archives live under `archive/` at project root, preserving original path:

    docs/api.md  →  archive/docs/api.md

The `archive/` tree is excluded from ripgrep by default.

When searching, prefer `rg` over `grep` — it respects `.rgignore` automatically.
If `grep` must be used, always exclude archive/:

    grep -r --exclude-dir=archive ...

## Verification Policy

- Run the smallest relevant verification command before declaring done.
- Never claim tests passed unless they actually ran and passed.
- If verification cannot run, explain exactly why.

Final response must include:
- Files changed
- Docs updated, or: `Docs checked; no documentation update required.`
- Verification command run and result
- Remaining risks

## Git-Safe Move Policy

All tracked file moves MUST use `git mv`. Direct `mv`/`rename` on tracked files is forbidden.

For docs archiving: always use `agents_rule archive`. This ensures the move is recorded as a rename in Git, not delete+add.

Expected `git status` after archiving:

    R  docs/old.md -> archive/docs/old.md
# END agents_rule-base
