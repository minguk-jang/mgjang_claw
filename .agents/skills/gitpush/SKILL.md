---
name: gitpush
description: Add, commit, and push repository changes to origin on the current branch with one trigger. Use when the user writes `/gitpush` or asks to "git add + commit + push", "push current session changes", or "commit and push current branch". Supports optional commit message text after `/gitpush`.
---

# Git Push

Run `scripts/gitpush.sh` to stage all changes, create a commit, and push to `origin/<current-branch>`.

## Trigger Handling

Treat these requests as this skill:
- `/gitpush`
- `/gitpush <commit message>`
- "현재 변경사항 add/commit/push 해줘"
- "origin 현재 브랜치로 push해줘"

If the user provides text after `/gitpush`, use it as the commit message.
If no message is provided, use the script default timestamp message.

## Workflow

1. Confirm the working tree with `git status --short` and show a short summary to the user.
2. Run:
```bash
bash scripts/gitpush.sh "<commit message>"
```
3. Report the result:
- branch name
- new commit hash (if a commit was created)
- push destination (`origin/<branch>`)

## Guardrails

- Do not run `git push --force` unless explicitly requested.
- Do not run `git pull`, `rebase`, or history-rewriting commands unless explicitly requested.
- If there are no file changes, still attempt a plain push only when local commits are ahead.
