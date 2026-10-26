// Posts the evidence of a device-check run to the Jira ticket named by the branch (ADR 0019).
//
//   node scripts/ci/jira-evidence.mjs run     one comment with both verdicts; screenshots when a check failed or QA found an issue
//   node scripts/ci/jira-evidence.mjs merge   the screenshots of the PR's last device-check run, and one comment naming them
//
// Inputs come from the environment: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY (optional), BRANCH,
// PR_URL, RUN_URL, EVIDENCE_DIR (the downloaded artifacts, one folder per artifact: qa-agent, qa-report,
// maestro-android; any may be missing), and for `run` also MAESTRO_RESULT, GATE_RESULT and APK_RESULT (job results).
// Jira must never change a device-check result: every failure prints a ::warning:: and the script exits 0.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { parseTicketKey } from "./ticket-key.mjs";

function warn(message) {
  console.log(`::warning::jira-evidence: ${message}`);
}

function stop(message) {
  console.log(`jira-evidence: ${message}`);
  process.exit(0);
}

const command = process.argv[2];
if (command !== "run" && command !== "merge") {
  warn(`unknown command "${command ?? ""}", use "run" or "merge"`);
  process.exit(0);
}

const branch = process.env.BRANCH ?? "";
const key = parseTicketKey(branch, "branch");
if (key === null) stop(`branch "${branch}" has no ticket key, nothing to post`);

const projectKey = process.env.JIRA_PROJECT_KEY || undefined;
if (projectKey && parseTicketKey(branch, "branch", projectKey) === null) {
  warn(`${key} is not a ticket of project ${projectKey}, nothing posted`);
  process.exit(0);
}

for (const name of [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "EVIDENCE_DIR",
]) {
  if (!process.env[name]) {
    warn(`${name} is not set, nothing posted`);
    process.exit(0);
  }
}

const baseUrl = process.env.JIRA_BASE_URL.replace(/\/+$/, "");
const auth = `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64")}`;
// A missing folder means no artifact was downloaded; the run comment is still posted.
const evidenceDir = existsSync(process.env.EVIDENCE_DIR)
  ? realpathSync(process.env.EVIDENCE_DIR)
  : resolve(process.env.EVIDENCE_DIR);
const prUrl = process.env.PR_URL ?? "";
const runUrl = process.env.RUN_URL ?? "";

// One call to the ticket's REST endpoint. Returns true on a 2xx answer, false on any other answer, and null when Jira
// did not answer; it warns on both. A call that takes over a minute is given up, so a hung Jira is a warning and not
// the job's timeout.
async function jira(step, path, init) {
  let response;
  try {
    response = await fetch(`${baseUrl}/rest/api/3/issue/${key}/${path}`, {
      ...init,
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    warn(`${step} on ${key} failed: ${error.cause?.message ?? error.message}`);
    return null;
  }
  if (!response.ok) {
    const hint =
      response.status === 404
        ? " (no such ticket, or the Jira account cannot see it)"
        : "";
    warn(`${step} on ${key} failed: Jira answered ${response.status}${hint}`);
    return false;
  }
  return true;
}

// Uploads each file in its own request, so one file Jira refuses, such as one over its size limit, does not drop the
// others. Stops at the first call Jira does not answer, so a hung Jira costs one timeout and not one per file.
// Returns the names Jira took and the names it did not.
async function attach(files) {
  const attached = [];
  const failed = [];
  let reachable = true;
  for (const file of files) {
    const name = basename(file);
    if (reachable) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([readFileSync(file)], { type: "image/png" }),
        name,
      );
      const ok = await jira(`uploading screenshot ${name}`, "attachments", {
        method: "POST",
        headers: { "X-Atlassian-Token": "no-check" },
        body: form,
      });
      if (ok) {
        attached.push(name);
        continue;
      }
      reachable = ok !== null;
    }
    failed.push(name);
  }
  return { attached, failed };
}

async function comment(content) {
  await jira("posting the comment", "comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: { type: "doc", version: 1, content } }),
  });
}

// Atlassian Document Format nodes. Jira rejects empty text nodes, so callers pass only non-empty text.
const text = (value) => ({ type: "text", text: value });
const strong = (value) => ({
  type: "text",
  text: value,
  marks: [{ type: "strong" }],
});
const link = (href) => ({
  type: "text",
  text: href,
  marks: [{ type: "link", attrs: { href } }],
});
const paragraph = (...content) => ({ type: "paragraph", content });
const bullets = (items) => ({
  type: "bulletList",
  content: items.map((item) => ({
    type: "listItem",
    content: [paragraph(text(item))],
  })),
});

function links() {
  const content = [];
  if (prUrl) content.push(text("PR: "), link(prUrl));
  if (runUrl)
    content.push(text(content.length > 0 ? " · Run: " : "Run: "), link(runUrl));
  return content.length > 0 ? [paragraph(...content)] : [];
}

function readQaReport() {
  const path = join(evidenceDir, "qa-report", "qa-report.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn("qa-report.json is not valid JSON, the QA verdict is left out");
    return null;
  }
}

// Every file of an artifact folder, as paths relative to it.
function filesIn(folder) {
  const path = join(evidenceDir, folder);
  return existsSync(path)
    ? readdirSync(path, { recursive: true }).map(String)
    : [];
}

// Passed and failed flows, summed over Maestro's JUnit reports.
function maestroCounts() {
  const reports = filesIn("maestro-android").filter((file) =>
    /(^|\/)maestro-report-[^/]*\.xml$/.test(file),
  );
  if (reports.length === 0) return null;
  let tests = 0;
  let failures = 0;
  for (const file of reports) {
    const xml = readFileSync(
      join(evidenceDir, "maestro-android", file),
      "utf8",
    );
    for (const suite of xml.matchAll(/<testsuite\b[^>]*>/g)) {
      tests += Number(/\btests="(\d+)"/.exec(suite[0])?.[1] ?? 0);
      failures += Number(/\bfailures="(\d+)"/.exec(suite[0])?.[1] ?? 0);
    }
  }
  return { passed: tests - failures, failed: failures };
}

// Keeps a path only when it really is a .png inside the evidence folder, so a path written in qa-report.json
// cannot upload other files from the runner.
function safeScreenshot(folder, path) {
  let real;
  try {
    real = realpathSync(resolve(evidenceDir, folder, path));
  } catch {
    warn(`screenshot ${path} was not found, skipped`);
    return null;
  }
  if (!real.startsWith(evidenceDir + sep)) {
    warn(`screenshot ${path} is outside the artifacts, skipped`);
    return null;
  }
  if (!real.endsWith(".png")) {
    warn(`screenshot ${path} is not a .png, skipped`);
    return null;
  }
  return real;
}

function screenshots(qa) {
  const qaPaths = [...(qa?.checked ?? []), ...(qa?.issues ?? [])]
    .map((item) => item.screenshot)
    .filter((path) => typeof path === "string" && path !== "")
    .map((path) => safeScreenshot("qa-agent", path));
  // The report can be another attempt's after a re-run, so every .png the QA agent saved is attached too.
  const qaFolderPaths = filesIn("qa-agent")
    .filter((file) => file.startsWith("qa-artifacts/") && file.endsWith(".png"))
    .map((file) => safeScreenshot("qa-agent", file));
  const maestroPaths = filesIn("maestro-android")
    .filter((file) => file.endsWith(".png"))
    .map((file) => safeScreenshot("maestro-android", file));
  return [
    ...new Set(
      [...qaPaths, ...qaFolderPaths, ...maestroPaths].filter(
        (path) => path !== null,
      ),
    ),
  ];
}

function qaVerdict(qa) {
  if (qa === null)
    return [
      paragraph(
        strong("QA agent: no report"),
        text(" (the job did not run or its report is missing)."),
      ),
    ];
  const verdict = qa.tooling_failure
    ? `inconclusive (tooling failure: ${qa.tooling_failure})`
    : qa.status.replace("_", " ");
  const content = [
    paragraph(
      strong(`QA agent: ${verdict}`),
      ...(qa.summary ? [text(` ${qa.summary}`)] : []),
    ),
  ];
  if (qa.checked.length > 0) {
    content.push(
      paragraph(text("Checked:")),
      bullets(
        qa.checked.map(
          (item) => `${item.screen}: ${item.expectation} (${item.result})`,
        ),
      ),
    );
  }
  if (qa.issues.length > 0) {
    content.push(
      paragraph(text("Issues:")),
      bullets(qa.issues.map((issue) => `${issue.title}: ${issue.detail}`)),
    );
  }
  return content;
}

const MAESTRO_WORDS = { success: "passed", failure: "failed" };

function maestroVerdict(result) {
  const counts = maestroCounts();
  const detail = counts
    ? ` ${counts.passed} flows passed, ${counts.failed} failed.`
    : "";
  return [
    paragraph(
      strong(`Maestro: ${MAESTRO_WORDS[result] ?? result ?? "unknown"}`),
      ...(detail ? [text(detail)] : []),
    ),
  ];
}

function attachedList({ attached, failed }) {
  return [
    ...(attached.length > 0
      ? [paragraph(text("Attached screenshots:")), bullets(attached)]
      : []),
    ...(failed.length > 0
      ? [
          paragraph(
            text("Screenshots Jira did not take (see the run's warnings):"),
          ),
          bullets(failed),
        ]
      : []),
  ];
}

async function postRun() {
  const heading = paragraph(strong("Device-check run"));
  if (
    process.env.GATE_RESULT !== "success" ||
    process.env.APK_RESULT !== "success"
  ) {
    await comment([
      heading,
      paragraph(
        text(
          "The device checks were stopped by an earlier stage and did not run.",
        ),
      ),
      ...links(),
    ]);
    return;
  }
  const qa = readQaReport();
  const maestroResult = process.env.MAESTRO_RESULT;
  const flagged =
    maestroResult === "failure" || (qa !== null && qa.status !== "pass");
  const uploads = flagged
    ? await attach(screenshots(qa))
    : { attached: [], failed: [] };
  await comment([
    heading,
    ...qaVerdict(qa),
    ...maestroVerdict(maestroResult),
    ...attachedList(uploads),
    ...links(),
  ]);
}

async function postMerge() {
  const files = screenshots(readQaReport());
  if (files.length === 0) {
    warn(
      "no screenshots found in the last device-check run (the checks took none, or its artifacts have expired), nothing posted",
    );
    return;
  }
  const uploads = await attach(files);
  if (uploads.attached.length === 0) return;
  await comment([
    paragraph(
      strong("Merged."),
      text(
        " Screenshots from the last device-check run of this PR are attached.",
      ),
    ),
    ...attachedList(uploads),
    ...links(),
  ]);
}

// Anything unexpected, such as a malformed report, is a warning too.
try {
  if (command === "run") await postRun();
  else await postMerge();
} catch (error) {
  warn(`stopped by an unexpected error: ${error.message}`);
}
