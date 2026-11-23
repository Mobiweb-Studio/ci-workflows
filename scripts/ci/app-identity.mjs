// Prints the device-check app's id and URL scheme from the resolved Expo config, as GITHUB_ENV lines:
//
//   pnpm exec expo config --json | node scripts/ci/app-identity.mjs <android|ios>
//   APP_ID=com.example.app.dev
//   APP_SCHEME=example.dev
//
// The config is the one the build reads (APP_VARIANT, APP_ENV and the other switches in the environment), so the
// ids follow whatever the project's app.config.ts does with them, such as a `.dev` suffix for APP_ENV=dev, and CI
// never has to repeat that rule. APP_ID is `android.package` or `ios.bundleIdentifier`. APP_SCHEME is the platform's
// own `scheme`, or the top-level one, the first when it is a list; empty when the app has none.
//
// Text before the JSON (a warning Expo printed on stdout) is skipped. A config with no id for the platform stops
// with an error: the Maestro flows would otherwise launch an app that is not installed.
import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`app-identity: ${message}\n`);
  process.exit(1);
}

const platform = process.argv[2];
if (platform !== "android" && platform !== "ios") {
  fail(`the platform must be android or ios, got "${platform ?? ""}"`);
}

const text = readFileSync(0, "utf8");
const start = text.indexOf("{");
let config;
try {
  config = JSON.parse(text.slice(start));
} catch {
  fail("stdin is not the JSON printed by `expo config --json`");
}
if (start < 0 || !config || typeof config !== "object") {
  fail("stdin is not the JSON printed by `expo config --json`");
}

const section = config[platform] ?? {};
const id = platform === "android" ? section.package : section.bundleIdentifier;
// An id is letters, digits, underscores, hyphens and dots; anything else would break the GITHUB_ENV line.
if (typeof id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(id)) {
  fail(`the config has no ${platform === "android" ? "android.package" : "ios.bundleIdentifier"}`);
}

let scheme = section.scheme ?? config.scheme ?? "";
if (Array.isArray(scheme)) scheme = scheme[0] ?? "";
if (typeof scheme !== "string" || !/^[A-Za-z0-9+.-]*$/.test(scheme)) {
  fail(`the config's scheme is not a URL scheme: ${JSON.stringify(scheme)}`);
}

process.stdout.write(`APP_ID=${id}\nAPP_SCHEME=${scheme}\n`);
