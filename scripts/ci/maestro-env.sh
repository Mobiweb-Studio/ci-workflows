#!/usr/bin/env bash
# A project's Maestro variables, from the secret MAESTRO_ENV: one MAESTRO_<NAME>=<value> per line, as in a .env file,
# without quotes. Blank lines and lines that start with # are skipped. Without MAESTRO_ENV both commands do nothing,
# and neither ever prints a value.
#
#   maestro-env.sh export          Masks each value in the log, then puts the variables in the environment of the
#                                  job's later steps. Maestro reads MAESTRO_* variables on its own, so a flow uses
#                                  ${MAESTRO_<NAME>} and the values never reach a command line.
#   maestro-env.sh redact <path>…  Replaces each value with *** in the text files under the paths. Maestro's debug
#                                  output (commands.json, maestro.log) and its reports hold the typed text, so this runs
#                                  before they are uploaded, and leaves none on a self-hosted runner's disk.
set -euo pipefail

command="${1:-}"
shift || true
if [ -z "${MAESTRO_ENV:-}" ]; then
  exit 0
fi

names=()
values=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  case "$line" in
    '' | '#'*) continue ;;
  esac
  name="${line%%=*}"
  if [[ "$line" != *=* || ! "$name" =~ ^MAESTRO_[A-Z0-9_]+$ ]]; then
    echo "Line $n of MAESTRO_ENV is not MAESTRO_<NAME>=<value>." >&2
    exit 1
  fi
  names+=("$name")
  values+=("${line#*=}")
done <<< "$MAESTRO_ENV"

case "$command" in
  export)
    for i in "${!names[@]}"; do
      if [ -n "${values[$i]}" ]; then
        echo "::add-mask::${values[$i]}"
      fi
      echo "${names[$i]}=${values[$i]}" >> "$GITHUB_ENV"
    done
    ;;
  redact)
    for value in "${values[@]}"; do
      if [ -z "$value" ]; then
        continue
      fi
      # The value goes through the environment, never the command line. Images and videos are left alone.
      REDACT_VALUE="$value" find "$@" -type f ! -name '*.png' ! -name '*.jpg' ! -name '*.mp4' \
        -exec perl -pi -e 's/\Q$ENV{REDACT_VALUE}\E/***/g' {} + 2> /dev/null || true
    done
    ;;
  *)
    echo "Usage: maestro-env.sh export | redact <path>..." >&2
    exit 1
    ;;
esac
