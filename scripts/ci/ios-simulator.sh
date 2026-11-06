#!/usr/bin/env bash
# Gives a device job a simulator of its own, and removes it afterwards.
#
#   ios-simulator.sh create <app>   Creates ci-<run id>-<attempt> on the newest iOS runtime, in en_US, boots it,
#                                   installs the app and writes IOS_UDID to GITHUB_ENV.
#   ios-simulator.sh delete         Shuts down, erases and deletes the simulator in IOS_UDID, if any.
#
# The device type is the last iPhone the runtime supports, because a fixed name breaks when a runtime drops it.
# The language is set before the flows run because a new simulator takes the Mac's language, and the flows assert
# text in the language the Android emulator uses.
set -euo pipefail

case "${1:-}" in
  create)
    app="${2:?usage: ios-simulator.sh create <app>}"
    runtime=$(xcrun simctl list runtimes -j | node -e '
      const ios = JSON.parse(require("fs").readFileSync(0, "utf8")).runtimes
        .filter((r) => r.platform === "iOS" && r.isAvailable);
      if (!ios.length) { console.error("No iOS simulator runtime is installed."); process.exit(1); }
      const newest = ios.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).pop();
      const phones = newest.supportedDeviceTypes.filter((d) => d.productFamily === "iPhone");
      console.log(newest.identifier, phones[phones.length - 1].identifier);
    ')
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
