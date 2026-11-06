// Sums up one runtime of the weekly iOS regression, after run-maestro.sh ran every flow with MAESTRO_ALL_FLOWS=true.
//
//   node scripts/ci/ios-regression-summary.mjs     in the project's checkout, after the flows ran
//
// Reads the flows run-maestro.sh runs (.maestro/flows and vendors/$APP_VARIANT/maestro), their `ios` tag, and the
// JUnit report each one left (maestro-report-<name>.xml). Writes a table to GITHUB_STEP_SUMMARY (stdout without it),
// with the regressions (flows tagged `ios` that failed or left no report) and the candidates (untagged flows that
// passed, which can now be tagged). Exits 1 when there is a regression, so the run fails only for those; an untagged
// flow that fails on iOS is expected.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const runtime = process.env.IOS_RUNTIME || "newest";
const vendor = process.env.APP_VARIANT || "default";

function flowsIn(folder) {
  return existsSync(folder)
    ? readdirSync(folder).filter((f) => f.endsWith(".yml")).sort().map((f) => join(folder, f))
    : [];
}

// The same rule as run-maestro.sh: `ios` in the tags of the config section, before the `---` line.
function taggedIos(text) {
  const config = text.split(/^---\s*$/m)[0];
  return /^\s*-\s*ios\s*$/m.test(config) || /^\s*tags:.*[^a-z]ios([^a-z]|$)/m.test(config);
}

function result(name) {
  const path = `maestro-report-${name}.xml`;
  if (!existsSync(path)) return "no report";
  const xml = readFileSync(path, "utf8");
  let tests = 0;
  let failures = 0;
  for (const suite of xml.matchAll(/<testsuite\b[^>]*>/g)) {
    tests += Number(/\btests="(\d+)"/.exec(suite[0])?.[1] ?? 0);
    failures += Number(/\b(?:failures|errors)="(\d+)"/.exec(suite[0])?.[1] ?? 0);
  }
  if (tests === 0) return "no report";
  return failures > 0 ? "failed" : "passed";
}

const rows = [...flowsIn(".maestro/flows"), ...flowsIn(join("vendors", vendor, "maestro"))].map((path) => {
  const name = basename(path, ".yml");
  return { path, tagged: taggedIos(readFileSync(path, "utf8")), result: result(name) };
});
const regressions = rows.filter((r) => r.tagged && r.result !== "passed");
const candidates = rows.filter((r) => !r.tagged && r.result === "passed");

const lines = [
  `### iOS ${runtime}`,
  "",
  "| Flow | Tagged ios | Result |",
  "|---|---|---|",
  ...rows.map((r) => `| \`${r.path}\` | ${r.tagged ? "yes" : "no"} | ${r.result} |`),
  "",
  regressions.length
    ? `**Regressions:** ${regressions.map((r) => `\`${r.path}\``).join(", ")} (tagged ios, ${regressions.length === 1 ? "it does" : "they do"} not pass).`
    : "**Regressions:** none.",
  candidates.length
    ? `**Can be tagged ios:** ${candidates.map((r) => `\`${r.path}\``).join(", ")} (untagged, passed).`
    : "**Can be tagged ios:** none.",
  "",
];
const text = lines.join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
else process.stdout.write(`${text}\n`);
for (const r of regressions) console.log(`::error::iOS ${runtime}: ${r.path} is tagged ios and ${r.result === "failed" ? "failed" : "left no report"}`);
for (const r of candidates) console.log(`::notice::iOS ${runtime}: ${r.path} passed and can be tagged ios`);
process.exit(regressions.length ? 1 : 0);
