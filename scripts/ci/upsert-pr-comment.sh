#!/usr/bin/env bash
# Creates or updates the one pull request comment that carries a marker, so a workflow can keep a single
# comment up to date and never overwrites a comment that belongs to another workflow.
#
# Usage: scripts/ci/upsert-pr-comment.sh [--only-existing] <marker> <pr-number> <body-file>
#
# The comment body is the body file with a hidden marker line on top. With --only-existing a missing
# comment is left missing. Needs GH_TOKEN and GITHUB_REPOSITORY, and jq.
set -euo pipefail

only_existing=false
if [ "${1:-}" = "--only-existing" ]; then
  only_existing=true
  shift
fi
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 [--only-existing] <marker> <pr-number> <body-file>" >&2
  exit 2
fi
marker="<!-- $1 -->"
pr="$2"
body_file="$3"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
{
  echo "$marker"
  cat "$body_file"
} > "$body"

# --paginate prints one JSON array per page; jq -s joins them before the marker is looked for. Only a
# comment written by a bot counts, so a person who quotes the marker cannot take the comment over.
comment_id="$(
  gh api "repos/$repo/issues/$pr/comments" --paginate \
    | jq -s -r --arg marker "$marker" 'add // [] | map(select(.user.type == "Bot" and (.body | contains($marker)))) | first | .id // empty'
)"

if [ -n "$comment_id" ]; then
  gh api -X PATCH "repos/$repo/issues/comments/$comment_id" -F "body=@$body" > /dev/null
elif [ "$only_existing" = false ]; then
  gh api -X POST "repos/$repo/issues/$pr/comments" -F "body=@$body" > /dev/null
fi
