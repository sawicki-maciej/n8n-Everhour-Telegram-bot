#!/usr/bin/env bash
# Fails when any commit (file contents or commit message) matches the regex in $FORBIDDEN_WORDS.
# The regex lives in a repository secret, so the names it guards never appear in this public repo.
# Prints only commit and file names, never the matching text.
set -euo pipefail

if [ -z "${FORBIDDEN_WORDS:-}" ]; then
  echo "::notice::FORBIDDEN_WORDS is not set (repository secret missing, or a pull request from a fork): check skipped"
  exit 0
fi

status=0
files=$(git rev-list --all | xargs -r git grep -I -i -l -E -e "$FORBIDDEN_WORDS" 2>/dev/null || true)
if [ -n "$files" ]; then
  echo "::error::private names found in file contents (commit:path)"
  echo "$files"
  status=1
fi
commits=$(git log --all -i -E --grep="$FORBIDDEN_WORDS" --format='%h' || true)
if [ -n "$commits" ]; then
  echo "::error::private names found in commit messages"
  echo "$commits"
  status=1
fi
[ "$status" -eq 0 ] && echo "no private names in $(git rev-list --all --count) commit(s)"
exit "$status"
