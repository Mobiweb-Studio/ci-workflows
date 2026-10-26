#!/usr/bin/env bash
# Runs the Maestro flows every vendor has, plus the ones only the vendor under test has.
# Needs APP_VARIANT (the vendor) and APP_ID (its Android package). Its own file because the
# emulator action runs a script one line at a time.
#
# Each flow runs on its own, after the app has been stopped and Android has had a few seconds
# to close its window. A flow starts by clearing the app's data; when the previous flow left the
# app open, Android's clean-up of that old window killed the freshly launched app, and the flow
# saw a blank screen.
set -euo pipefail

flows=(.maestro/flows/*.yml)
if [ -d "vendors/$APP_VARIANT/maestro" ]; then
  flows+=("vendors/$APP_VARIANT/maestro"/*.yml)
fi

failed=0
for flow in "${flows[@]}"; do
  adb shell am force-stop "$APP_ID"
  sleep 3
  name=$(basename "$flow" .yml)
  maestro test -e APP_ID="$APP_ID" "$flow" --format junit --output "maestro-report-$name.xml" || failed=1
done
exit "$failed"
