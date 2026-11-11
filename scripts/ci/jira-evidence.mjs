// Posts the evidence of a device-check run to the Jira ticket named by the branch, or to its story's QA sub-task
// (ADR 0019).
//
//   node scripts/ci/jira-evidence.mjs run     one comment with both verdicts; screenshots when a check failed or QA found an issue
//   node scripts/ci/jira-evidence.mjs merge   the screenshots of the PR's last device-check run, and one comment naming them
//
// Inputs come from the environment: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY (optional), BRANCH,
// PR_URL, RUN_URL, EVIDENCE_DIR (the downloaded artifacts, one folder per artifact: qa-agent, qa-report,
// maestro-android, maestro-ios; any may be missing), and for `run` also MAESTRO_RESULT, GATE_RESULT and APK_RESULT
// (job results), and MAESTRO_IOS_RESULT (empty or `skipped` when the project runs no iOS check).
//
// JIRA_EVIDENCE_TARGET picks the ticket that gets the evidence. `branch-ticket`, the default, is the ticket named by the
// branch. `qa-subtask` is the story's QA sub-task: the branch's ticket, or its parent when it is a sub-task, is the
// story, and its one sub-task with the label JIRA_QA_LABEL (default `qa`) gets the evidence. With no such sub-task, or
// more than one, or when Jira cannot be read, the evidence goes to the branch's ticket with a ::warning::. The Jira
// account only reads, comments and attaches: the QA sub-task is made by a person, never by this script.
//
// JIRA_EVIDENCE_STORAGE picks where the files go. `jira`, the default, attaches the screenshots to the ticket.
// `onedrive` uploads the screenshots and qa-report.json to a SharePoint or OneDrive document library with Microsoft
// Graph, on every run, and the comment links the folder with a view-only link for the organization (never anonymous):
//   <ONEDRIVE_FOLDER>/<story>/<ticket>/PR-<PR_NUMBER>/<RUN_ID>-attempt-<RUN_ATTEMPT>/   the run mode
//   <ONEDRIVE_FOLDER>/<story>/<ticket>/PR-<PR_NUMBER>/merged/                          the merge mode
// It needs MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (an app registration with Sites.Selected, granted write on
// the one site) and MS_DRIVE_ID. MS_LOGIN_URL and MS_GRAPH_URL replace Microsoft's hosts in tests only; no workflow
// sets them.
// Jira and OneDrive must never change a device-check result: every failure prints a ::warning:: and the script
// exits 0.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
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

const TARGETS = ["branch-ticket", "qa-subtask"];
let targetMode = process.env.JIRA_EVIDENCE_TARGET || "branch-ticket";
if (!TARGETS.includes(targetMode)) {
  warn(
    `unknown JIRA_EVIDENCE_TARGET "${targetMode}", use "branch-ticket" or "qa-subtask"; posting to ${key}`,
  );
  targetMode = "branch-ticket";
}
const qaLabel = process.env.JIRA_QA_LABEL || "qa";
// The ticket that gets the comment and the screenshots, set by resolveTarget before anything is posted, and the
// story it belongs to, which names the evidence folder.
let target = key;
let story = key;

const STORAGES = ["jira", "onedrive"];
let storage = process.env.JIRA_EVIDENCE_STORAGE || "jira";
if (!STORAGES.includes(storage)) {
  warn(
    `unknown JIRA_EVIDENCE_STORAGE "${storage}", use "jira" or "onedrive"; attaching to Jira`,
  );
  storage = "jira";
}

// One call to Jira's REST API about one issue. Returns the response on a 2xx answer, false on any other answer, and
// null when Jira did not answer; it warns on both. A call that takes over a minute is given up, so a hung Jira is a
// warning and not the job's timeout.
async function request(step, issue, path, init = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}/rest/api/3/issue/${issue}${path}`, {
      ...init,
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    warn(
      `${step} on ${issue} failed: ${error.cause?.message ?? error.message}`,
    );
    return null;
  }
  if (!response.ok) {
    const hint =
      response.status === 404
        ? " (no such ticket, or the Jira account cannot see it)"
        : "";
    warn(`${step} on ${issue} failed: Jira answered ${response.status}${hint}`);
    return false;
  }
  return response;
}

// One call to the target ticket's REST endpoint. Returns true on a 2xx answer, false on any other answer, and null
// when Jira did not answer.
async function jira(step, path, init) {
  const response = await request(step, target, `/${path}`, init);
  return response ? true : response;
}

// Reads the given fields of one issue. Returns null when Jira did not give them; request() has warned.
async function fields(issue, names) {
  const response = await request(`reading ${names}`, issue, `?fields=${names}`);
  if (!response) return null;
  return (await response.json()).fields ?? {};
}

// The story's one sub-task with the QA label, or the reason why there is none to post to.
async function findQaSubtask() {
  const own = await fields(key, "subtasks,issuetype,parent");
  if (own === null) return { reason: `${key} could not be read` };
  let story = key;
  let subtasks = own.subtasks ?? [];
  if (own.issuetype?.subtask) {
    story = own.parent?.key;
    if (!story) return { reason: `${key} is a sub-task with no parent` };
    const parent = await fields(story, "subtasks");
    if (parent === null)
      return { reason: `its story ${story} could not be read` };
    subtasks = parent.subtasks ?? [];
  }
  // The sub-task list in an issue carries no labels, so each sub-task is read on its own.
  const labelled = [];
  for (const subtask of subtasks) {
    const its = await fields(subtask.key, "labels");
    if (its === null)
      return {
        story,
        reason: `sub-task ${subtask.key} of ${story} could not be read`,
      };
    if ((its.labels ?? []).includes(qaLabel)) labelled.push(subtask.key);
  }
  if (labelled.length === 0)
    return {
      story,
      reason: `no sub-task of ${story} has the label "${qaLabel}"`,
    };
  if (labelled.length > 1)
    return {
      story,
      reason: `${labelled.length} sub-tasks of ${story} have the label "${qaLabel}" (${labelled.join(", ")})`,
    };
  return { story, subtask: labelled[0] };
}

async function resolveTarget() {
  if (targetMode !== "qa-subtask") return;
  let found;
  try {
    found = await findQaSubtask();
  } catch (error) {
    found = { reason: `Jira's answer could not be read: ${error.message}` };
  }
  if (found.story) story = found.story;
  if (found.subtask) {
    target = found.subtask;
    console.log(
      `jira-evidence: posting to ${target}, the QA sub-task of ${found.story}`,
    );
    return;
  }
  warn(`no QA sub-task to post to: ${found.reason}; posting to ${key} instead`);
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

// Microsoft Graph. Tests point these at a stand-in server; no workflow sets them.
const loginUrl = (
  process.env.MS_LOGIN_URL || "https://login.microsoftonline.com"
).replace(/\/+$/, "");
const graphUrl = (
  process.env.MS_GRAPH_URL || "https://graph.microsoft.com/v1.0"
).replace(/\/+$/, "");
// Files up to this size go in one request; larger ones through an upload session, in chunks that are a multiple of
// 320 KiB as Graph requires.
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const CHUNK_SIZE = 10 * 320 * 1024;

// One call to Microsoft. Returns the response on a 2xx answer, false on any other answer, and null when there was no
// answer; it warns on both. A 429 or 503 is tried once more after its Retry-After (30 seconds at most). The step
// names never carry the URL, because an upload session's URL is itself a credential.
async function microsoft(step, url, init = {}, retried = false) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    warn(`${step} failed: ${error.cause?.message ?? error.message}`);
    return null;
  }
  if ((response.status === 429 || response.status === 503) && !retried) {
    const seconds = Math.min(Number(response.headers.get("retry-after")) || 1, 30);
    await new Promise((done) => setTimeout(done, seconds * 1000));
    return microsoft(step, url, init, true);
  }
  if (!response.ok) {
    warn(`${step} failed: Microsoft answered ${response.status}`);
    return false;
  }
  return response;
}

// SharePoint refuses some characters in names, and a name that ends with a dot or a space. A segment made only of
// dots, such as "..", becomes "_", so no name can leave the run's folder.
function safeSegment(name) {
  const cleaned = name
    .replace(/["*:<>?\\|]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned === "" ? "_" : cleaned;
}

const drivePath = (segments) =>
  segments.map((segment) => encodeURIComponent(safeSegment(segment))).join("/");

// The run's folder under ONEDRIVE_FOLDER, as path segments.
function evidenceFolder() {
  const root = (process.env.ONEDRIVE_FOLDER ?? "").split("/").filter(Boolean);
  const run =
    command === "run"
      ? `${process.env.RUN_ID}-attempt-${process.env.RUN_ATTEMPT}`
      : "merged";
  return [...root, story, target, `PR-${process.env.PR_NUMBER}`, run];
}

async function graphToken() {
  const response = await microsoft(
    "getting a Microsoft Graph token",
    `${loginUrl}/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!response) return null;
  return (await response.json()).access_token ?? null;
}

// Uploads one file to the drive path. Returns true, false (refused) or null (no answer), like microsoft().
async function uploadFile(token, drive, path, file, name) {
  const bytes = readFileSync(file);
  const item = `${graphUrl}/drives/${encodeURIComponent(drive)}/root:/${path}:`;
  const auth = { Authorization: `Bearer ${token}` };
  if (bytes.length <= SIMPLE_UPLOAD_LIMIT) {
    const response = await microsoft(
      `uploading ${name} to OneDrive`,
      `${item}/content?@microsoft.graph.conflictBehavior=replace`,
      {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: bytes,
      },
    );
    return response ? true : response;
  }
  const session = await microsoft(
    `opening an upload session for ${name}`,
    `${item}/createUploadSession`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        item: { "@microsoft.graph.conflictBehavior": "replace" },
      }),
    },
  );
  if (!session) return session;
  const { uploadUrl } = await session.json();
  if (!uploadUrl) {
    warn(`opening an upload session for ${name} failed: no upload URL`);
    return false;
  }
  // The session URL is pre-authenticated, so it gets no Authorization header.
  for (let start = 0; start < bytes.length; start += CHUNK_SIZE) {
    const chunk = bytes.subarray(start, start + CHUNK_SIZE);
    const response = await microsoft(`uploading ${name} to OneDrive`, uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${bytes.length}`,
      },
      body: chunk,
    });
    if (!response) return response;
  }
  return true;
}

// A view-only link to the folder for people in the organization, never an anonymous one. When the tenant refuses
// such a link, the folder's own address, which opens for people with access to the library, with a warning.
async function folderLink(token, drive, folder) {
  const auth = { Authorization: `Bearer ${token}` };
  const found = await microsoft(
    "reading the evidence folder",
    `${graphUrl}/drives/${encodeURIComponent(drive)}/root:/${drivePath(folder)}`,
    { headers: auth },
  );
  if (!found) return null;
  const { id, webUrl } = await found.json();
  const shared = await microsoft(
    "making the folder's view link",
    `${graphUrl}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(id)}/createLink`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "view", scope: "organization" }),
    },
  );
  const link = shared ? (await shared.json()).link?.webUrl : undefined;
  if (link) return link;
  if (webUrl)
    warn(
      "no organization link to the evidence folder, the comment gives the folder's own address",
    );
  return webUrl ?? null;
}

// Uploads the files to the run's folder, each in its own request so one refused file does not drop the others, and
// stops at the first call Microsoft does not answer. Returns the folder's link (null when nothing was stored) and the
// names stored and not.
async function store(files) {
  const names = files.map((file) => relative(evidenceDir, file));
  const none = { url: null, stored: [], failed: names };
  if (files.length === 0) return none;
  for (const name of [
    "MS_TENANT_ID",
    "MS_CLIENT_ID",
    "MS_CLIENT_SECRET",
    "MS_DRIVE_ID",
    "PR_NUMBER",
    ...(command === "run" ? ["RUN_ID", "RUN_ATTEMPT"] : []),
  ]) {
    if (!process.env[name]) {
      warn(`${name} is not set, the evidence is not stored`);
      return none;
    }
  }
  const token = await graphToken();
  if (!token) return none;
  const drive = process.env.MS_DRIVE_ID;
  const folder = evidenceFolder();
  const stored = [];
  const failed = [];
  let reachable = true;
  for (const [index, file] of files.entries()) {
    const name = names[index];
    if (reachable) {
      const path = drivePath([...folder, ...name.split(sep)]);
      const ok = await uploadFile(token, drive, path, file, name);
      if (ok) {
        stored.push(name);
        continue;
      }
      reachable = ok !== null;
    }
    failed.push(name);
  }
  if (stored.length === 0) return { url: null, stored, failed };
  const url = await folderLink(token, drive, folder);
  console.log(
    `jira-evidence: stored ${stored.length} files in ${folder.join("/")}`,
  );
  return { url, stored, failed };
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

// Passed and failed flows, summed over Maestro's JUnit reports in one artifact folder.
function maestroCounts(folder) {
  const reports = filesIn(folder).filter((file) =>
    /(^|\/)maestro-report-[^/]*\.xml$/.test(file),
  );
  if (reports.length === 0) return null;
  let tests = 0;
  let failures = 0;
  for (const file of reports) {
    const xml = readFileSync(join(evidenceDir, folder, file), "utf8");
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
  const maestroPaths = ["maestro-android", "maestro-ios"].flatMap((folder) =>
    filesIn(folder)
      .filter((file) => file.endsWith(".png"))
      .map((file) => safeScreenshot(folder, file)),
  );
  return [
    ...new Set(
      [...qaPaths, ...qaFolderPaths, ...maestroPaths].filter(
        (path) => path !== null,
      ),
    ),
  ];
}

// qa-report.json, when the run has one, stored beside the screenshots on OneDrive.
function qaReportFile() {
  const path = join(evidenceDir, "qa-report", "qa-report.json");
  if (!existsSync(path)) return [];
  const real = realpathSync(path);
  return real.startsWith(evidenceDir + sep) ? [real] : [];
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

function maestroVerdict(label, folder, result) {
  const counts = maestroCounts(folder);
  const detail = counts
    ? ` ${counts.passed} flows passed, ${counts.failed} failed.`
    : "";
  return [
    paragraph(
      strong(`${label}: ${MAESTRO_WORDS[result] ?? result ?? "unknown"}`),
      ...(detail ? [text(detail)] : []),
    ),
  ];
}

// The iOS check runs only for projects that set ios-runner; otherwise its job is skipped and the comment says nothing of it.
const iosRan = (result) => Boolean(result) && result !== "skipped";

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

function storedList({ url, stored, failed }) {
  if (!url)
    return failed.length > 0
      ? [
          paragraph(
            text(
              "The evidence could not be stored on OneDrive (see the run's warnings). The run's artifacts are kept on GitHub for 15 days.",
            ),
          ),
        ]
      : [];
  return [
    paragraph(
      text("Evidence: "),
      link(url),
      text(` (${stored.length} files)`),
    ),
    ...(failed.length > 0
      ? [
          paragraph(
            text("Files OneDrive did not take (see the run's warnings):"),
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
  const iosResult = process.env.MAESTRO_IOS_RESULT;
  const flagged =
    maestroResult === "failure" ||
    iosResult === "failure" ||
    (qa !== null && qa.status !== "pass");
  // On OneDrive every run is stored; Jira attachments only when something failed, to spare the Jira site's storage.
  const evidence =
    storage === "onedrive"
      ? storedList(await store([...screenshots(qa), ...qaReportFile()]))
      : attachedList(
          flagged
            ? await attach(screenshots(qa))
            : { attached: [], failed: [] },
        );
  await comment([
    heading,
    ...qaVerdict(qa),
    ...maestroVerdict("Maestro", "maestro-android", maestroResult),
    ...(iosRan(iosResult)
      ? maestroVerdict("Maestro on iOS", "maestro-ios", iosResult)
      : []),
    ...evidence,
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
  if (storage === "onedrive") {
    const stored = await store([...files, ...qaReportFile()]);
    if (!stored.url) return;
    await comment([
      paragraph(
        strong("Merged."),
        text(" Evidence from the last device-check run of this PR: "),
        link(stored.url),
        text(` (${stored.stored.length} files)`),
      ),
      ...(stored.failed.length > 0
        ? [
            paragraph(
              text("Files OneDrive did not take (see the run's warnings):"),
            ),
            bullets(stored.failed),
          ]
        : []),
      ...links(),
    ]);
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
  await resolveTarget();
  if (command === "run") await postRun();
  else await postMerge();
} catch (error) {
  warn(`stopped by an unexpected error: ${error.message}`);
}
