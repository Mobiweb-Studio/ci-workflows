// Waits until the named checks of a commit have all passed, so a later stage of the pull request checks
// starts only after the earlier ones did (ADR 0018).
//
//   node scripts/ci/wait-for-checks.mjs    exits 0 when every named check passed, 1 on the first failure or at the time limit
//
// Inputs come from the environment: REPOSITORY (owner/name), COMMIT_SHA (the pull request's head commit),
// CHECKS (one check name per line), TIMEOUT_SECONDS, INTERVAL_SECONDS and GRACE_SECONDS (all optional), and
// GH_TOKEN for gh.
// Only a `success` passes. A check that failed, timed out or was skipped stops the wait at once: a named check
// is skipped only when an earlier one failed. A `cancelled` run is usually one that a new push, edit or label
// replaced (the workflow cancels in-progress runs of the same ref), and the replacement's check runs can take a
// moment to appear. So a check whose newest run is `cancelled` is "not yet" for GRACE_SECONDS (default 90),
// counted from the poll that first saw that run; it fails, naming the check, only if no newer run appeared by
// then. Of several runs with one name the newest counts
// (the highest id), so a re-run replaces the old result. A name with no run yet, a run still going and a failed
// API call are all "not yet": the script keeps polling and fails at the time limit, saying which. It never
// reports success on a result it could not read.
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`wait-for-checks: ${message}\n`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`${name} is required`);
  return value.trim();
}

function seconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    fail(`${name} must be a number of seconds, got "${raw}"`);
  return value;
}

const repository = required("REPOSITORY");
const sha = required("COMMIT_SHA");
const names = required("CHECKS")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const timeoutSeconds = seconds("TIMEOUT_SECONDS", 900);
const intervalSeconds = seconds("INTERVAL_SECONDS", 10);
const graceSeconds = seconds("GRACE_SECONDS", 90);

// One call to the API. Returns the check runs, or null when the call failed or its output was not readable.
function readCheckRuns() {
  const result = spawnSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
      "--jq",
      ".check_runs[] | {id, name, status, conclusion}",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  try {
    return result.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

// When each cancelled run was first seen, by check name: { id, since }. A newer run of the name starts over.
const cancelledSeen = new Map();

// The verdict for the named checks given the runs read now: the first one that stopped the wait, else what is
// still missing, running or cancelled within its grace period, else a pass.
function evaluate(runs) {
  const latest = new Map();
  for (const checkRun of runs) {
    if (!names.includes(checkRun.name)) continue;
    const known = latest.get(checkRun.name);
    if (!known || checkRun.id > known.id) latest.set(checkRun.name, checkRun);
  }
  const missing = [];
  const unfinished = [];
  const cancelled = [];
  for (const name of names) {
    const checkRun = latest.get(name);
    if (!checkRun) missing.push(name);
    else if (checkRun.status !== "completed") unfinished.push(name);
    else if (checkRun.conclusion === "cancelled") {
      let seen = cancelledSeen.get(name);
      if (!seen || seen.id !== checkRun.id) {
        seen = { id: checkRun.id, since: Date.now() };
        cancelledSeen.set(name, seen);
      }
      if (Date.now() - seen.since >= graceSeconds * 1000)
        return {
          state: "failed",
          message: `${name} ended as cancelled and no newer run appeared within ${graceSeconds} seconds, so the later stages do not run`,
        };
      cancelled.push(name);
    } else if (checkRun.conclusion !== "success")
      return {
        state: "failed",
        message: `${name} ended as ${checkRun.conclusion}, so the later stages do not run`,
      };
  }
  if (missing.length || unfinished.length || cancelled.length)
    return { state: "pending", missing, unfinished, cancelled };
  return { state: "passed" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + timeoutSeconds * 1000;
let verdict = null;

for (;;) {
  const runs = readCheckRuns();
  if (runs) {
    verdict = evaluate(runs);
    if (verdict.state === "failed") fail(verdict.message);
    if (verdict.state === "passed") {
      process.stdout.write(
        `Every check before this stage passed: ${names.join(", ")}\n`,
      );
      process.exit(0);
    }
  }
  if (Date.now() >= deadline) break;
  await sleep(intervalSeconds * 1000);
}

if (!verdict)
  fail(
    `the check runs of ${sha} could not be read from the API within ${timeoutSeconds} seconds`,
  );
const parts = [];
if (verdict.missing.length)
  parts.push(`${verdict.missing.join(", ")} did not appear`);
if (verdict.unfinished.length)
  parts.push(`${verdict.unfinished.join(", ")} still running`);
if (verdict.cancelled.length)
  parts.push(
    `${verdict.cancelled.join(", ")} cancelled, waiting for a newer run`,
  );
fail(`gave up after ${timeoutSeconds} seconds: ${parts.join("; ")}`);
