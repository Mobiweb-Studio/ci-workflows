#!/usr/bin/env bash
# Runs the Maestro flows every vendor has, plus the ones only the vendor under test has.
# Needs APP_VARIANT (the vendor) and APP_ID (its Android package, or its iOS bundle id). Its own file because the
# emulator action runs a script one line at a time.
#
# Where the flows are: a project with `.maestro/flows/` keeps every flow there. A project without it keeps one folder
# per feature, `.maestro/<feature>/*.yml`; a folder whose name starts with `_` (shared subflows) is not run on its own.
# Either way, `vendors/<vendor>/maestro/*.yml` is added.
#
# Each flow runs on its own, after the app has been stopped and Android has had a few seconds
# to close its window. A flow starts by clearing the app's data; when the previous flow left the
# app open, Android's clean-up of that old window killed the freshly launched app, and the flow
# saw a blank screen. Each flow writes its screenshots and logs to `maestro-output/<flow>/`, so the
# artifact names them by flow instead of by Maestro's timestamps.
#
# With MAESTRO_PLATFORM=ios it runs on the simulator in IOS_UDID, and only the flows whose config section tags
# them `ios`: a flow written for Android (its text, its system dialogs) is opted in once it passes on iOS. With
# MAESTRO_ALL_FLOWS=true it runs every flow, tagged or not, which the iOS regression uses to find the
# flows that could be tagged.
#
# MAESTRO_TAGS (tags separated by spaces or commas) keeps only the flows with at least one of them; empty runs them
# all. MAESTRO_EXCLUDE_TAGS drops the flows with any of them, as the PR checks do with `nightly`.
set -euo pipefail

platform="${MAESTRO_PLATFORM:-android}"
all_flows="${MAESTRO_ALL_FLOWS:-false}"
include_value="${MAESTRO_TAGS:-}"
exclude_value="${MAESTRO_EXCLUDE_TAGS:-}"
# Split on spaces and commas. macOS's bash 3.2 treats an empty array as unset under `set -u`, so the arrays are only
# expanded after their length is checked.
read -r -a include_tags <<< "${include_value//,/ }" || true
read -r -a exclude_tags <<< "${exclude_value//,/ }" || true

shopt -s nullglob
if [ -d .maestro/flows ]; then
  flows=(.maestro/flows/*.yml)
else
  flows=()
  for folder in .maestro/*/; do
    case "$(basename "$folder")" in _*) continue ;; esac
    flows+=("$folder"*.yml)
  done
fi
if [ -d "vendors/$APP_VARIANT/maestro" ]; then
  flows+=("vendors/$APP_VARIANT/maestro"/*.yml)
fi
shopt -u nullglob

# True when the flow's config section, before its `---` line, has the tag (`tags: [a, b]` or `- b`).
has_tag() {
  local tag="$2"
  sed -n '1,/^---/p' "$1" |
    grep -Eq "^[[:space:]]*-[[:space:]]*${tag}[[:space:]]*\$|^[[:space:]]*tags:.*[^a-zA-Z0-9_-]${tag}([^a-zA-Z0-9_-]|\$)"
}

has_any_tag() {
  local flow="$1"
  shift
  local tag
  for tag in "$@"; do
    has_tag "$flow" "$tag" && return 0
  done
  return 1
}

failed=0
ran=0
for flow in ${flows[@]+"${flows[@]}"}; do
  name=$(basename "$flow" .yml)
  if [ "${#include_tags[@]}" -gt 0 ] && ! has_any_tag "$flow" "${include_tags[@]}"; then
    echo "Not affected by this change, skipped: $flow"
    continue
  fi
  if [ "${#exclude_tags[@]}" -gt 0 ] && has_any_tag "$flow" "${exclude_tags[@]}"; then
    echo "Excluded by its tags, skipped: $flow"
    continue
  fi
  output="maestro-output/$name"
  if [ "$platform" = ios ]; then
    if [ "$all_flows" != true ] && ! has_tag "$flow" ios; then
      echo "Not tagged ios, skipped: $flow"
      continue
    fi
    xcrun simctl terminate "$IOS_UDID" "$APP_ID" 2>/dev/null || true
    sleep 2
    maestro --device "$IOS_UDID" test -e APP_ID="$APP_ID" "$flow" --format junit --output "maestro-report-$name.xml" \
      --test-output-dir "$output" || failed=1
  else
    adb shell am force-stop "$APP_ID"
    sleep 3
    maestro test -e APP_ID="$APP_ID" "$flow" --format junit --output "maestro-report-$name.xml" \
      --test-output-dir "$output" || failed=1
  fi
  ran=$((ran + 1))
done

if [ "$ran" -eq 0 ]; then
  echo "::warning::No Maestro flow ran on $platform. On iOS, tag ios the flows that pass there; with MAESTRO_TAGS, tag the flows the change affects."
fi
exit "$failed"
