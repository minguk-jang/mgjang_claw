#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" ]]; then
  echo "Error: detached HEAD; cannot push a branch." >&2
  exit 1
fi

message="${*:-chore: session update $(date '+%Y-%m-%d %H:%M:%S')}"

git add -A

if git diff --cached --quiet; then
  echo "No file changes staged."
  if git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
    ahead_count="$(git rev-list --count "origin/$branch..HEAD")"
    if [[ "$ahead_count" -gt 0 ]]; then
      git push origin "$branch"
      echo "Pushed ${ahead_count} existing local commit(s) to origin/$branch."
    else
      echo "Nothing to commit and nothing to push."
    fi
  else
    git push -u origin "$branch"
    echo "No upstream existed. Set upstream and pushed origin/$branch."
  fi
  exit 0
fi

git commit -m "$message"
commit_hash="$(git rev-parse --short HEAD)"

if git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
  git push origin "$branch"
else
  git push -u origin "$branch"
fi

echo "Created commit ${commit_hash} and pushed to origin/$branch."
