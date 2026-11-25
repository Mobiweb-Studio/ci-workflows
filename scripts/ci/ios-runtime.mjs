// Picks the iOS simulator runtime and the iPhone to create for a device job.
//
//   xcrun simctl list runtimes -j | node scripts/ci/ios-runtime.mjs [<version>]
//
// Prints "<runtime id> <device type id>". With no version, or "newest", it takes the newest available iOS runtime
// that has a plain "iPhone <number>", else the newest one; with a version such as 26.4 it takes the newest available
// runtime of that version (26.4, 26.4.1, ...). The device type comes from the runtime's own list, newest first,
// because a fixed name breaks when a runtime drops it: the first plain "iPhone <number>" (the standard screen size),
// else the first iPhone. A runtime can support only an odd device (iOS 27.1 has only the iPhone Duo, whose screens
// put the system's status over the app's corner), so "newest" skips such a runtime rather than test on that device.
// A version that is not installed stops with an error that lists what is, so the runner's maintainer knows what to
// install.
import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`ios-runtime: ${message}\n`);
  process.exit(1);
}

const wanted = process.argv[2] ?? "newest";
if (wanted !== "newest" && !/^\d+(\.\d+){0,2}$/.test(wanted)) {
  fail(`the version must look like 26.4 or be "newest", got "${wanted}"`);
}

let runtimes;
try {
  runtimes = JSON.parse(readFileSync(0, "utf8")).runtimes;
} catch {
  fail("stdin is not the JSON of `xcrun simctl list runtimes -j`");
}
const ios = (runtimes ?? [])
  .filter((r) => r.platform === "iOS" && r.isAvailable)
  .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
if (ios.length === 0) fail("no iOS simulator runtime is installed");

const matches = wanted === "newest"
  ? ios
  : ios.filter((r) => r.version === wanted || r.version.startsWith(`${wanted}.`));
if (matches.length === 0) {
  fail(`iOS ${wanted} is not installed on this runner; installed: ${ios.map((r) => r.version).join(", ")}`);
}
const phonesOf = (r) => (r.supportedDeviceTypes ?? []).filter((d) => d.productFamily === "iPhone");
const plainPhone = (r) => phonesOf(r).find((d) => /^iPhone \d+$/.test(d.name));
const runtime =
  (wanted === "newest" && matches.findLast((r) => plainPhone(r) !== undefined)) || matches[matches.length - 1];
const phones = phonesOf(runtime);
if (phones.length === 0) fail(`iOS ${runtime.version} supports no iPhone`);

const phone = plainPhone(runtime) ?? phones[0];
process.stdout.write(`${runtime.identifier} ${phone.identifier}\n`);
