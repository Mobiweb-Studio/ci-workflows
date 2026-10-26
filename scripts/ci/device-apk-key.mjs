// Makes the cache key of the device-check APK from the native fingerprint. The key is what decides between
// repacking a cached APK and building a new one: a hit means the native side is the same, so repacking the JS is
// safe; any other fingerprint or vendor is a miss, so the action builds. Keep every input that changes the
// native app in the key.
//
//   node scripts/ci/device-apk-key.mjs <vendor>    reads the JSON of `fingerprint:generate` on stdin, prints the key
//
// A missing or malformed fingerprint stops with an error: the script never prints a key that could match
// another build.
import { readFileSync } from "node:fs";

// Bump when the way the APK is built changes (the architecture, the build type), so old APKs are not reused.
const KEY_VERSION = "v1";
const ARCH = "x86_64";

function fail(message) {
  process.stderr.write(`device-apk-key: ${message}\n`);
  process.exit(1);
}

const vendor = process.argv[2];
if (!vendor || !/^[A-Za-z0-9_-]+$/.test(vendor)) {
  fail(`the vendor must be a folder name, got "${vendor ?? ""}"`);
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

process.stdout.write(`device-apk-${KEY_VERSION}-${ARCH}-${vendor}-${hash}\n`);
