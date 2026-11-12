import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The poster with JIRA_EVIDENCE_STORAGE=onedrive: the files go to a OneDrive library through Microsoft Graph and the
// Jira comment links the folder. jira-evidence.test.ts covers the Jira side and the default, `jira`.
const script = join(__dirname, "jira-evidence.mjs");

type Request = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

const CLIENT_SECRET = "client-secret-value";
const GRAPH_TOKEN = "graph-token-value";
const SESSION_PATH = "/upload/session-secret-1";
const FOLDER_URL = "https://mobiweb.sharepoint.com/sites/qa/QA%20evidence/folder";
const LINK_URL = "https://mobiweb.sharepoint.com/:f:/s/qa/org-link";
const RUN_FOLDER = "/graph/drives/drive-1/root:/ICligo/QA%20evidence/ICLIGO-1/ICLIGO-2/PR-7/99-attempt-2";

const qaReport = {
  status: "pass",
  summary: "The home screen shows the item list.",
  checked: [
    {
      screen: "Home",
      expectation: "The list shows items",
      result: "ok",
      screenshot: "qa-artifacts/01-home.png",
    },
  ],
  issues: [],
  check: "pass",
  tooling_failure: null,
  tooling_notes: [],
};

// Collects every text and link target of an ADF document.
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own: string[] = [];
  if (typeof record.text === "string") own.push(record.text);
  if (typeof record.href === "string") own.push(record.href);
  return [...own, ...Object.values(record).flatMap(texts)];
}

describe("jira-evidence with OneDrive storage", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Request[];
  let issues: Record<string, Record<string, unknown>>;
  let tokenStatus: number;
  let linkStatus: number;
  let refused: string | undefined;
  let hangUpOnUpload: boolean;
  let busyOnce: boolean;
  let dir: string;

  // A stand-in for Jira, Microsoft's token endpoint and Graph, recording every request.
  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = request.url ?? "";
        const method = request.method ?? "";
        requests.push({ method, url, headers: request.headers, body: Buffer.concat(chunks) });
        const answer = (status: number, body: unknown = {}) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (url.startsWith("/rest/api/3/issue/") && method === "GET") {
          const issue = /\/issue\/([^/?]+)\?/.exec(url)?.[1] ?? "";
          const fields = issues[issue];
          answer(fields ? 200 : 404, { key: issue, fields });
        } else if (url.startsWith("/rest/api/3/")) {
          answer(201);
        } else if (url === "/login/tenant-1/oauth2/v2.0/token") {
          answer(tokenStatus, tokenStatus === 200 ? { access_token: GRAPH_TOKEN } : {});
        } else if (url.endsWith(":/createUploadSession")) {
          answer(200, { uploadUrl: `${baseUrl}${SESSION_PATH}` });
        } else if (url === SESSION_PATH) {
          answer(202);
        } else if (url.includes(":/content?")) {
          if (hangUpOnUpload) {
            request.socket.destroy();
          } else if (busyOnce) {
            busyOnce = false;
            response.writeHead(429, { "Retry-After": "0" });
            response.end();
          } else {
            answer(refused && url.includes(refused) ? 403 : 201);
          }
        } else if (method === "GET" && url.startsWith("/graph/drives/drive-1/root:/")) {
          answer(200, { id: "folder-id", webUrl: FOLDER_URL });
        } else if (url === "/graph/drives/drive-1/items/folder-id/createLink") {
          answer(linkStatus, linkStatus === 200 ? { link: { webUrl: LINK_URL } } : {});
        } else {
          answer(404);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requests = [];
    // ICLIGO-1 is the story; ICLIGO-2 is its QA sub-task.
    issues = {
      "ICLIGO-1": {
        issuetype: { subtask: false },
        subtasks: [{ key: "ICLIGO-2" }, { key: "ICLIGO-3" }],
      },
      "ICLIGO-2": { labels: ["qa"] },
      "ICLIGO-3": {
        labels: [],
        issuetype: { subtask: true },
        parent: { key: "ICLIGO-1" },
      },
    };
    tokenStatus = 200;
    linkStatus = 200;
    refused = undefined;
    hangUpOnUpload = false;
    busyOnce = false;
    dir = mkdtempSync(join(tmpdir(), "jira-evidence-onedrive-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const withEvidence = () => {
    write("qa-report/qa-report.json", JSON.stringify(qaReport));
    write("qa-agent/qa-artifacts/01-home.png", "png bytes");
  };

  const run = (command: string, env: Record<string, string | undefined> = {}) => {
    const fullEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      JIRA_BASE_URL: baseUrl,
      JIRA_EMAIL: "bot@example.com",
      JIRA_API_TOKEN: "jira-token",
      JIRA_EVIDENCE_TARGET: "qa-subtask",
      JIRA_EVIDENCE_STORAGE: "onedrive",
      MS_LOGIN_URL: `${baseUrl}/login`,
      MS_GRAPH_URL: `${baseUrl}/graph`,
      MS_TENANT_ID: "tenant-1",
      MS_CLIENT_ID: "client-1",
      MS_CLIENT_SECRET: CLIENT_SECRET,
      MS_DRIVE_ID: "drive-1",
      ONEDRIVE_FOLDER: "ICligo/QA evidence",
      PR_NUMBER: "7",
      RUN_ID: "99",
      RUN_ATTEMPT: "2",
      BRANCH: "feat/ICLIGO-1-launch",
      PR_URL: "https://github.com/acme/app/pull/7",
      RUN_URL: "https://github.com/acme/app/actions/runs/99",
      MAESTRO_RESULT: "success",
      GATE_RESULT: "success",
      APK_RESULT: "success",
      EVIDENCE_DIR: dir,
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete fullEnv[name];
      else fullEnv[name] = value;
    }
    return new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [script, command], {
        env: fullEnv as NodeJS.ProcessEnv,
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("close", (status) => resolve({ status, output }));
    });
  };

  const comments = (issue = "ICLIGO-2") =>
    requests.filter((request) => request.url === `/rest/api/3/issue/${issue}/comment`);
  const commentText = (issue = "ICLIGO-2") =>
    texts(JSON.parse(comments(issue)[0].body.toString()).body).join("\n");
  const uploads = () =>
    requests.filter((request) => request.method === "PUT" && request.url.includes(":/content?"));
  const tokenRequests = () => requests.filter((request) => request.url.startsWith("/login/"));
  const warnings = (output: string) =>
    output.split("\n").filter((line) => line.startsWith("::warning::"));

  it("stores a passing run's screenshots and report in the run's folder and links it from the QA sub-task", async () => {
    withEvidence();
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(warnings(result.output)).toEqual([]);

    const [token] = tokenRequests();
    const form = new URLSearchParams(token.body.toString());
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("client-1");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");

    expect(uploads().map((request) => request.url).sort()).toEqual([
      `${RUN_FOLDER}/qa-agent/01-home.png:/content?@microsoft.graph.conflictBehavior=replace`,
      `${RUN_FOLDER}/qa-report.json:/content?@microsoft.graph.conflictBehavior=replace`,
    ]);
    for (const upload of uploads()) {
      expect(upload.headers.authorization).toBe(`Bearer ${GRAPH_TOKEN}`);
    }

    const link = requests.find((request) => request.url.endsWith("/createLink"));
    expect(JSON.parse(link?.body.toString() ?? "")).toEqual({
      type: "view",
      scope: "organization",
    });

    expect(requests.some((request) => request.url.endsWith("/attachments"))).toBe(false);
    expect(comments()).toHaveLength(1);
    const text = commentText();
    expect(text).toContain("QA agent: pass");
    expect(text).toContain("Evidence: ");
    expect(text).toContain(LINK_URL);
    expect(text).toContain("(2 files)");
  });

  it("names the folder after the branch's ticket in branch-ticket mode", async () => {
    withEvidence();
    await run("run", { JIRA_EVIDENCE_TARGET: undefined });
    expect(uploads()[0].url).toContain("/QA%20evidence/ICLIGO-1/ICLIGO-1/PR-7/99-attempt-2/");
    expect(comments("ICLIGO-1")).toHaveLength(1);
  });

  it("keeps the story in the folder when the evidence falls back to a sub-task branch's own ticket", async () => {
    issues["ICLIGO-2"] = { labels: [] };
    withEvidence();
    const result = await run("run", { BRANCH: "feat/ICLIGO-3-part" });
    expect(warnings(result.output).join("\n")).toContain("no QA sub-task to post to");
    expect(uploads()[0].url).toContain("/QA%20evidence/ICLIGO-1/ICLIGO-3/PR-7/99-attempt-2/");
    expect(comments("ICLIGO-3")).toHaveLength(1);
  });

  it("stores the merge evidence in the PR's merged folder", async () => {
    withEvidence();
    const result = await run("merge", { RUN_ID: undefined, RUN_ATTEMPT: undefined });
    expect(result.status).toBe(0);
    expect(warnings(result.output)).toEqual([]);
    expect(uploads()[0].url).toContain("/QA%20evidence/ICLIGO-1/ICLIGO-2/PR-7/merged/");
    const text = commentText();
    expect(text).toContain("Merged.");
    expect(text).toContain(LINK_URL);
  });

  it("uploads a file over 4 MiB through an upload session, in chunks, without the token on the session URL", async () => {
    withEvidence();
    const size = 4 * 1024 * 1024 + 10;
    write("maestro-android/big.png", Buffer.alloc(size, 1));
    const result = await run("run");
    expect(warnings(result.output)).toEqual([]);
    const session = requests.find((request) => request.url.endsWith(":/createUploadSession"));
    expect(session?.url).toBe(`${RUN_FOLDER}/android/big.png:/createUploadSession`);
    const chunks = requests.filter((request) => request.url === SESSION_PATH);
    const chunk = 10 * 320 * 1024;
    expect(chunks.map((request) => request.headers["content-range"])).toEqual([
      `bytes 0-${chunk - 1}/${size}`,
      `bytes ${chunk}-${size - 1}/${size}`,
    ]);
    for (const request of chunks) expect(request.headers.authorization).toBeUndefined();
    expect(commentText()).toContain("(3 files)");
  });

  it("names Maestro's files by platform and flow, and stores a summary of the flows", async () => {
    write(
      "maestro-android/maestro-report-happy-path.xml",
      '<testsuites><testsuite tests="1" failures="0"><testcase id="happy-path" name="happy-path"/></testsuite></testsuites>',
    );
    write(
      "maestro-ios/maestro-report-offline.xml",
      '<testsuites><testsuite tests="1" failures="1"><testcase name="offline"><failure>no</failure></testcase></testsuite></testsuites>',
    );
    write("maestro-android/maestro-output/happy-path/screenshots/home.png", "png bytes");
    write("maestro-ios/.maestro/tests/2026-11-12_113444/old.png", "png bytes");
    await run("run");
    const names = uploads().map((request) => request.url.slice(RUN_FOLDER.length + 1).split(":/content")[0]);
    expect(names.sort()).toEqual([
      "android/happy-path/screenshots/home.png",
      "ios/2026-11-12_113444/old.png",
      "summary.md",
    ]);
    const summary = uploads()
      .find((request) => request.url.includes("/summary.md:"))
      ?.body.toString();
    expect(summary).toContain("| android | happy-path | passed |");
    expect(summary).toContain("| ios | offline | failed |");
  });

  it("replaces the characters SharePoint refuses in a file name", async () => {
    write("maestro-android/home: list?.png", "png bytes");
    await run("run");
    expect(uploads().map((request) => request.url)).toEqual([
      `${RUN_FOLDER}/android/home_%20list_.png:/content?@microsoft.graph.conflictBehavior=replace`,
    ]);
  });

  it("stores the other files and lists the one OneDrive refused", async () => {
    withEvidence();
    refused = "01-home.png";
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(warnings(result.output).join("\n")).toContain(
      "uploading qa-agent/01-home.png to OneDrive failed: Microsoft answered 403",
    );
    const text = commentText();
    expect(text).toContain(LINK_URL);
    expect(text).toContain("(1 files)");
    expect(text).toContain("Files OneDrive did not take");
    expect(text).toContain("qa-agent/01-home.png");
  });

  it("tries a busy Graph once more after its Retry-After", async () => {
    withEvidence();
    busyOnce = true;
    const result = await run("run");
    expect(warnings(result.output)).toEqual([]);
    expect(uploads()).toHaveLength(3);
    expect(commentText()).toContain("(2 files)");
  });

  it("stops at the first upload Graph does not answer and still posts the comment", async () => {
    withEvidence();
    write("maestro-android/fail.png", "png bytes");
    hangUpOnUpload = true;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(uploads()).toHaveLength(1);
    const text = commentText();
    expect(text).toContain("QA agent: pass");
    expect(text).toContain("could not be stored on OneDrive");
  });

  it("posts the comment without evidence and warns when Microsoft refuses the token", async () => {
    withEvidence();
    tokenStatus = 401;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(warnings(result.output).join("\n")).toContain(
      "getting a Microsoft Graph token failed: Microsoft answered 401",
    );
    expect(uploads()).toHaveLength(0);
    expect(commentText()).toContain("could not be stored on OneDrive");
  });

  it.each(["MS_CLIENT_SECRET", "MS_DRIVE_ID", "PR_NUMBER", "RUN_ATTEMPT"])(
    "posts the comment without evidence and names %s when it is missing, without falling back to Jira",
    async (name) => {
      withEvidence();
      const result = await run("run", { [name]: undefined });
      expect(result.status).toBe(0);
      expect(warnings(result.output).join("\n")).toContain(`${name} is not set`);
      expect(tokenRequests()).toHaveLength(0);
      expect(requests.some((request) => request.url.endsWith("/attachments"))).toBe(false);
      expect(commentText()).toContain("could not be stored on OneDrive");
    },
  );

  it("gives the folder's own address with a warning when the organization link is refused", async () => {
    withEvidence();
    linkStatus = 403;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(warnings(result.output).join("\n")).toContain("no organization link");
    expect(commentText()).toContain(FOLDER_URL);
  });

  it("never prints the client secret, the token or the upload session's URL", async () => {
    withEvidence();
    write("maestro-android/big.png", Buffer.alloc(4 * 1024 * 1024 + 1, 1));
    refused = "01-home.png";
    const result = await run("run");
    for (const secret of [CLIENT_SECRET, GRAPH_TOKEN, SESSION_PATH]) {
      expect(result.output).not.toContain(secret);
    }
  });

  it("attaches to Jira as before when the storage is unknown, with a warning", async () => {
    withEvidence();
    const result = await run("run", { JIRA_EVIDENCE_STORAGE: "dropbox" });
    expect(warnings(result.output).join("\n")).toContain('unknown JIRA_EVIDENCE_STORAGE "dropbox"');
    expect(tokenRequests()).toHaveLength(0);
    expect(commentText()).not.toContain("Evidence: ");
  });
});
