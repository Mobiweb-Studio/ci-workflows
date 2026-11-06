#!/usr/bin/env bash
# Gives a device job a simulator of its own, and removes it afterwards.
#
#   ios-simulator.sh create <app>   Creates ci-<run id>-<attempt> on the iOS runtime in IOS_RUNTIME (a version such
#                                   as 26.4; empty or "newest" for the newest installed), in en_US, boots it,
#                                   installs the app and writes IOS_UDID to GITHUB_ENV.
#   ios-simulator.sh delete         Shuts down, erases and deletes the simulator in IOS_UDID, if any.
#
# ios-runtime.mjs picks the runtime and the iPhone.
# The language is set before the flows run because a new simulator takes the Mac's language, and the flows assert
# text in the language the Android emulator uses.
set -euo pipefail

case "${1:-}" in
  create)
    app="${2:?usage: ios-simulator.sh create <app>}"
    runtime=$(xcrun simctl list runtimes -j | node "$(dirname "$0")/ios-runtime.mjs" "${IOS_RUNTIME:-newest}")
    read -r runtime_id device_type <<<"$runtime"
    udid=$(xcrun simctl create "ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" "$device_type" "$runtime_id")
    echo "IOS_UDID=$udid" >> "$GITHUB_ENV"
    echo "Simulator $udid: $device_type on $runtime_id"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b
    xcrun simctl spawn "$udid" defaults write -g AppleLanguages -array en-US
    xcrun simctl spawn "$udid" defaults write -g AppleLocale -string en_US
    # The language applies from the next boot.
    xcrun simctl shutdown "$udid"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b
    xcrun simctl install "$udid" "$app"
    ;;
  delete)
    if [ -n "${IOS_UDID:-}" ]; then
      xcrun simctl shutdown "$IOS_UDID" 2>/dev/null || true
      xcrun simctl erase "$IOS_UDID" 2>/dev/null || true
      xcrun simctl delete "$IOS_UDID" 2>/dev/null || true
    fi
    ;;
  *)
    echo "usage: ios-simulator.sh create <app> | delete" >&2
    exit 2
    ;;
esac
