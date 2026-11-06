#!/usr/bin/env bash
# Runs the Maestro flows every vendor has, plus the ones only the vendor under test has.
# Needs APP_VARIANT (the vendor) and APP_ID (its Android package, or its iOS bundle id). Its own file because the
# emulator action runs a script one line at a time.
#
# Each flow runs on its own, after the app has been stopped and Android has had a few seconds
# to close its window. A flow starts by clearing the app's data; when the previous flow left the
# app open, Android's clean-up of that old window killed the freshly launched app, and the flow
# saw a blank screen.
#
# With MAESTRO_PLATFORM=ios it runs on the simulator in IOS_UDID, and only the flows whose config section tags
# them `ios`: a flow written for Android (its text, its system dialogs) is opted in once it passes on iOS.
set -euo pipefail

platform="${MAESTRO_PLATFORM:-android}"

flows=(.maestro/flows/*.yml)
if [ -d "vendors/$APP_VARIANT/maestro" ]; then
  flows+=("vendors/$APP_VARIANT/maestro"/*.yml)
fi

# True when the flow's config section, before its `---` line, has `ios` in its tags (`tags: [ios]` or `- ios`).
tagged_ios() {
  sed -n '1,/^---/p' "$1" | grep -Eq '^[[:space:]]*-[[:space:]]*ios[[:space:]]*$|^[[:space:]]*tags:.*[^a-z]ios([^a-z]|$)'
}

failed=0
ran=0
for flow in "${flows[@]}"; do
  name=$(basename "$flow" .yml)
  if [ "$platform" = ios ]; then
    if ! tagged_ios "$flow"; then
      echo "Not tagged ios, skipped: $flow"
      continue
    fi
    xcrun simctl terminate "$IOS_UDID" "$APP_ID" 2>/dev/null || true
    sleep 2
    maestro --device "$IOS_UDID" test -e APP_ID="$APP_ID" "$flow" --format junit --output "maestro-report-$name.xml" || failed=1
  else
    adb shell am force-stop "$APP_ID"
    sleep 3
    maestro test -e APP_ID="$APP_ID" "$flow" --format junit --output "maestro-report-$name.xml" || failed=1
  fi
  ran=$((ran + 1))
done

if [ "$ran" -eq 0 ]; then
  echo "::warning::No Maestro flow ran on $platform. On iOS, tag ios the flows that pass there."
fi
exit "$failed"
