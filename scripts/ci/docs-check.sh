#!/usr/bin/env bash
# Fails when a PR changes feature code without touching a feature doc or an ADR.
# Usage: scripts/ci/docs-check.sh <base-sha> <head-sha>
# Set HAS_NO_DOCS_LABEL=true (the PR has the `no-docs` label) to skip the check.
set -euo pipefail

base="$1"
head="$2"

if [ "${HAS_NO_DOCS_LABEL:-false}" = "true" ]; then
  echo "The no-docs label is set; skipping the docs check."
  exit 0
fi

changed=$(git diff --name-only "$base...$head")
code=$(printf '%s\n' "$changed" | grep -E '^src/(pages|features|entities|widgets)/' | grep -vE '\.(test|spec)\.[jt]sx?$' || true)
docs=$(printf '%s\n' "$changed" | grep -E '^docs/(features|adr)/' || true)

if [ -n "$code" ] && [ -z "$docs" ]; then
  echo "This PR changes feature code but no file under docs/features/ or docs/adr/:"
  printf '%s\n' "$code" | sed 's/^/  /'
  echo
  echo "Update the living feature doc (docs/features/<name>.md), or add an ADR if you made a decision."
  echo "If no documentation is needed, add the no-docs label and say why in the PR description."
  exit 1
fi

echo "Docs check passed."
