// Makes the cache key of the device-check app from the native fingerprint: the Android APK, or with `ios` the iOS
// simulator app. The key is what decides between repacking a cached app and building a new one: a hit means the
// native side is the same, so repacking the JS is safe; any other fingerprint, vendor or platform is a miss, so
// the action builds. Keep every input that changes the native app in the key.
//
//   node scripts/ci/device-apk-key.mjs <vendor> [android|ios]
//                                         reads the JSON of `fingerprint:generate` on stdin, prints the key
//
// DEVICE_APK_ABI names the Android APK's CPU architecture: x86_64 (the default, Linux runners) or arm64-v8a (an
// Apple Silicon Mac's emulator). An APK built for one never matches the other's key.
//
// APP_ENV names the project's app environment the app was built for (`dev`, say), which changes its ids and its
// config. When set, the key names it after the vendor (`default.dev`; a vendor folder has no dot), so a dev app and
// a prod one never share a cached build. Empty (the default build) leaves the key as it was before APP_ENV existed,
// so the APKs already cached stay valid.
//
// A missing or malformed fingerprint stops with an error: the script never prints a key that could match
// another build.
import { readFileSync } from "node:fs";

// Bump when the way an app is built changes (the architecture, the build type, the SDK), so old ones are not reused.
const KEY_VERSION = "v1";
const ARCH = process.env.DEVICE_APK_ABI || "x86_64";
const APP_ENV = process.env.APP_ENV ?? "";
// v2: the simulator app is ad-hoc signed with its entitlements; a v1 app was unsigned and cannot use the Keychain.
const IOS_KEY_VERSION = "v2";

function fail(message) {
  process.stderr.write(`device-apk-key: ${message}\n`);
  process.exit(1);
}

const vendor = process.argv[2];
if (!vendor || !/^[A-Za-z0-9_-]+$/.test(vendor)) {
  fail(`the vendor must be a folder name, got "${vendor ?? ""}"`);
}
if (ARCH !== "x86_64" && ARCH !== "arm64-v8a") {
  fail(`DEVICE_APK_ABI must be x86_64 or arm64-v8a, got "${ARCH}"`);
}
if (!/^[A-Za-z0-9_-]*$/.test(APP_ENV)) {
  fail(`APP_ENV must be a name of letters, digits, _ or -, got "${APP_ENV}"`);
}
const target = APP_ENV ? `${vendor}.${APP_ENV}` : vendor;
const platform = process.argv[3] ?? "android";
if (platform !== "android" && platform !== "ios") {
  fail(`the platform must be android or ios, got "${platform}"`);
}

let hash;
try {
  hash = JSON.parse(readFileSync(0, "utf8")).hash;
} catch {
  fail("stdin is not the JSON printed by fingerprint:generate");
}
if (typeof hash !== "string" || !/^[0-9a-f]{40}$/.test(hash)) {
  fail("the fingerprint has no valid hash");
}

process.stdout.write(
  platform === "ios"
    ? `device-app-ios-${IOS_KEY_VERSION}-simulator-${target}-${hash}\n`
    : `device-apk-${KEY_VERSION}-${ARCH}-${target}-${hash}\n`,
);
