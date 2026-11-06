// Makes the cache key of the device-check app from the native fingerprint: the Android APK, or with `ios` the iOS
// simulator app. The key is what decides between repacking a cached app and building a new one: a hit means the
// native side is the same, so repacking the JS is safe; any other fingerprint, vendor or platform is a miss, so
// the action builds. Keep every input that changes the native app in the key.
//
//   node scripts/ci/device-apk-key.mjs <vendor> [android|ios]
//                                         reads the JSON of `fingerprint:generate` on stdin, prints the key
//
// A missing or malformed fingerprint stops with an error: the script never prints a key that could match
// another build.
import { readFileSync } from "node:fs";

// Bump when the way an app is built changes (the architecture, the build type, the SDK), so old ones are not reused.
const KEY_VERSION = "v1";
const ARCH = "x86_64";
const IOS_KEY_VERSION = "v1";

function fail(message) {
  process.stderr.write(`device-apk-key: ${message}\n`);
  process.exit(1);
}

const vendor = process.argv[2];
if (!vendor || !/^[A-Za-z0-9_-]+$/.test(vendor)) {
  fail(`the vendor must be a folder name, got "${vendor ?? ""}"`);
}
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
    ? `device-app-ios-${IOS_KEY_VERSION}-simulator-${vendor}-${hash}\n`
    : `device-apk-${KEY_VERSION}-${ARCH}-${vendor}-${hash}\n`,
);
