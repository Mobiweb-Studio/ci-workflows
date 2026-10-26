#!/usr/bin/env bash
# Runs Claude Code as the QA agent. It may only run `agent-device` commands, ignores the
# repository's own Claude settings, and stops at 40 turns or $0.50 of model cost.
# Needs APP_VARIANT (the vendor under test) and APP_ID (its Android package).
set -uo pipefail

# The agent's instructions, followed by what is specific to the vendor's app.
{
  cat scripts/agent-qa/instructions.md
  printf '\n## About this app\n\n'
  sed "s/\${APP_ID}/$APP_ID/g" "vendors/$APP_VARIANT/qa-notes.md"
} > qa-instructions.md

claude -p \
  --model haiku \
  --max-turns 40 \
  --max-budget-usd 0.50 \
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
