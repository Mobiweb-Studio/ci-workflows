#!/usr/bin/env bash
# Runs Claude Code as the QA agent. It may only run `agent-device` commands, ignores the
# repository's own Claude settings, and stops at QA_MAX_TURNS turns or QA_MAX_BUDGET_USD of model
# cost (40 and $0.50 when unset). Needs APP_VARIANT (the vendor under test) and APP_ID (its Android
# package).
set -uo pipefail

# The agent's instructions, followed by what is specific to the vendor's app.
{
  cat scripts/agent-qa/instructions.md
  printf '\n## About this app\n\n'
  sed "s/\${APP_ID}/$APP_ID/g" "vendors/$APP_VARIANT/qa-notes.md"
} > qa-instructions.md

claude -p \
  --model haiku \
  --max-turns "${QA_MAX_TURNS:-40}" \
  --max-budget-usd "${QA_MAX_BUDGET_USD:-0.50}" \
  --output-format json \
  --no-session-persistence \
  --setting-sources user \
  --strict-mcp-config \
  --tools Bash \
  --allowedTools 'Bash(agent-device:*)' \
  --append-system-prompt-file qa-instructions.md \
  < qa-input.txt > qa-claude-output.json 2> qa-claude-error.log

echo "claude exit code: $?" >> qa-claude-error.log
exit 0
