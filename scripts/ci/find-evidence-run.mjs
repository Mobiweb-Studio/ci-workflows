// Finds the device-checks run whose evidence a merged PR attaches to its Jira ticket (ADR 0019).
//
//   node scripts/ci/find-evidence-run.mjs    prints the run id, or nothing when no run has evidence left
//
// Inputs come from the environment: GITHUB_REPOSITORY (owner/name), HEAD_SHA (the PR's head commit) and GH_TOKEN
// for gh. The runs are read newest first, and the first one with a qa-agent or maestro-android artifact that has
// not expired wins: those hold the screenshots, and a run whose device jobs were skipped or stopped by the gate has
// neither (it may still have a qa-report).
// Finding nothing is not an error: the script says why on stderr and exits 0, and the workflow warns.
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`find-evidence-run: ${message}\n`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`${name} is required`);
  return value.trim();
}

function none(message) {
  process.stderr.write(`find-evidence-run: ${message}\n`);
  process.exit(0);
}

const repository = required("GITHUB_REPOSITORY");
const sha = required("HEAD_SHA");

// One call to the API. Returns the parsed answer, or null when the call failed or its output was not readable.
function api(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const runs = api(
  `repos/${repository}/actions/workflows/device-checks.yml/runs?head_sha=${sha}&per_page=100`,
);
if (!runs) none(`the device-checks runs of ${sha} could not be read`);

for (const { id } of runs.workflow_runs) {
  const answer = api(`repos/${repository}/actions/runs/${id}/artifacts`);
  if (!answer) none(`the artifacts of run ${id} could not be read`);
  const evidence = answer.artifacts.some(
    ({ name, expired }) =>
      !expired && (name === "qa-agent" || name === "maestro-android"),
  );
  if (evidence) {
    process.stdout.write(`${id}\n`);
    process.exit(0);
  }
}

none(`no device-checks run of ${sha} still has its evidence artifacts`);
