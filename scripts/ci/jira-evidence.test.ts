import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(__dirname, "jira-evidence.mjs");

type JiraRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
};

type QaReport = {
  status: "pass" | "product_issue" | "inconclusive";
  summary: string;
  checked: {
    screen: string;
    expectation: string;
    result: string;
    screenshot?: string;
  }[];
  issues: { title: string; detail: string; screenshot?: string }[];
};

const passingReport: QaReport = {
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
};

const issueReport: QaReport = {
  status: "product_issue",
  summary: "The detail screen shows no title.",
  checked: [
    {
      screen: "Home",
      expectation: "The list shows items",
      result: "ok",
      screenshot: "qa-artifacts/01-home.png",
    },
  ],
  issues: [
    {
      title: "Missing title",
      detail: "The detail screen has an empty header.",
      screenshot: "qa-artifacts/02-detail.png",
    },
  ],
};

const junit = (tests: number, failures: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="Test Suite" tests="${tests}" failures="${failures}"></testsuite></testsuites>
`;

// Collects every text and link target of an ADF document, so a test can look for words without caring how the
// comment is laid out.
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own: string[] = [];
  if (typeof record.text === "string") own.push(record.text);
  if (typeof record.href === "string") own.push(record.href);
  return [...own, ...Object.values(record).flatMap(texts)];
}

describe("jira-evidence", () => {
  let server: Server;
  let baseUrl: string;
  let requests: JiraRequest[];
  let answerStatus: number;
  let attachmentStatus: number | undefined;
  let tooLarge: string | undefined;
  let hangUpOnUpload: boolean;
  let dir: string;

  // A stand-in for Jira: records every request and answers with answerStatus, or with attachmentStatus when set and
  // the request is an upload. It answers 413 to an upload of the file named tooLarge, and closes the connection
  // without an answer on every upload when hangUpOnUpload is set.
  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("latin1"),
        });
        const upload = request.url?.endsWith("/attachments") ?? false;
        if (upload && hangUpOnUpload) {
          request.socket.destroy();
          return;
        }
        const body = requests[requests.length - 1].body;
        const status = !upload
          ? answerStatus
          : tooLarge && body.includes(`filename="${tooLarge}"`)
            ? 413
            : (attachmentStatus ?? answerStatus);
        response.writeHead(status, {
          "Content-Type": "application/json",
        });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requests = [];
    answerStatus = 201;
    attachmentStatus = undefined;
    tooLarge = undefined;
    hangUpOnUpload = false;
    dir = mkdtempSync(join(tmpdir(), "jira-evidence-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Lays out the downloaded artifacts as the evidence job does: one folder per artifact.
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const withQa = (report: QaReport) => {
    write(
      "qa-report/qa-report.json",
      JSON.stringify({
        ...report,
        check: report.status === "pass" ? "pass" : "fail",
        tooling_failure: null,
        tooling_notes: [],
      }),
    );
    // Only the well-formed paths get a file; the others are what the poster must refuse.
    for (const item of [...report.checked, ...report.issues]) {
      const path = item.screenshot ?? "";
      if (path.startsWith("qa-artifacts/") && path.endsWith(".png")) {
        write(`qa-agent/${path}`, "png bytes");
      }
    }
  };

  // Runs the poster as the workflow does: inputs in the environment. Async, so the stand-in server can answer.
  const run = (
    command: string,
    env: Record<string, string | undefined> = {},
  ) => {
    const fullEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      JIRA_BASE_URL: baseUrl,
      JIRA_EMAIL: "bot@example.com",
      JIRA_API_TOKEN: "secret-token",
      BRANCH: "feat/MBLPT-12-agents-md",
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

  const comments = () =>
    requests.filter(
      (request) => request.url === "/rest/api/3/issue/MBLPT-12/comment",
    );
  const attachments = () =>
    requests.filter(
      (request) => request.url === "/rest/api/3/issue/MBLPT-12/attachments",
    );
  const uploaded = () =>
    attachments().map(
      (request) => /filename="([^"]*)"/.exec(request.body)?.[1] ?? "",
    );
  const commentText = () =>
    texts(JSON.parse(comments()[0].body).body).join("\n");
  const warnings = (output: string) =>
    output.split("\n").filter((line) => line.startsWith("::warning::"));

  it("posts one comment with both verdicts and both links, and no attachment, on a passing run", async () => {
    withQa(passingReport);
    write("maestro-android/maestro-report-1.xml", junit(3, 0));
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(comments()).toHaveLength(1);
    expect(comments()[0].method).toBe("POST");
    expect(attachments()).toHaveLength(0);
    const body = JSON.parse(comments()[0].body).body;
    expect(body.type).toBe("doc");
    expect(body.version).toBe(1);
    const text = commentText();
    expect(text).toContain("QA agent: pass");
    expect(text).toContain("Maestro: passed");
    expect(text).toContain("3 flows passed, 0 failed");
    expect(text).toContain("The list shows items");
    expect(text).toContain("https://github.com/acme/app/pull/7");
    expect(text).toContain("https://github.com/acme/app/actions/runs/99");
  });

  it("uploads the screenshots of a run where QA found a product issue one per request, and names them in the comment", async () => {
    withQa(issueReport);
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(uploaded()).toEqual(["01-home.png", "02-detail.png"]);
    for (const upload of attachments()) {
      expect(upload.headers["x-atlassian-token"]).toBe("no-check");
      expect(upload.headers["content-type"]).toMatch(/^multipart\/form-data/);
      expect(upload.body).toContain('name="file"; filename="');
      expect(requests.indexOf(upload)).toBeLessThan(
        requests.indexOf(comments()[0]),
      );
    }
    const text = commentText();
    expect(text).toContain("QA agent: product issue");
    expect(text).toContain("Missing title");
    expect(text).toContain("01-home.png");
    expect(text).toContain("02-detail.png");
  });

  it("attaches the Maestro failure screenshots found in the artifact on a failed Maestro run", async () => {
    withQa(passingReport);
    write("maestro-android/maestro-report-1.xml", junit(2, 1));
    write(
      "maestro-android/.maestro/tests/2026-10-22_101010/screenshot-❌-home.png",
      "png bytes",
    );
    const result = await run("run", { MAESTRO_RESULT: "failure" });
    expect(result.status).toBe(0);
    expect(uploaded()).toHaveLength(2);
    expect(uploaded().some((name) => name.startsWith("screenshot-"))).toBe(
      true,
    );
    expect(commentText()).toContain("Maestro: failed");
    expect(commentText()).toContain("1 flows passed, 1 failed");
  });

  it("attaches the screenshots of the given artifacts once in merge mode and posts one comment naming them", async () => {
    withQa(issueReport);
    write("maestro-android/.maestro/tests/run/failure.png", "png bytes");
    const result = await run("merge");
    expect(result.status).toBe(0);
    expect(uploaded()).toEqual(["01-home.png", "02-detail.png", "failure.png"]);
    expect(comments()).toHaveLength(1);
    const text = commentText();
    expect(text).toContain("01-home.png");
    expect(text).toContain("02-detail.png");
    expect(text).toContain("failure.png");
    expect(text).toContain("https://github.com/acme/app/pull/7");
  });

  const staleReport = () =>
    write(
      "qa-report/qa-report.json",
      JSON.stringify({
        status: "inconclusive",
        summary: "",
        checked: [],
        issues: [],
        check: "fail",
        tooling_failure: null,
        tooling_notes: [],
      }),
    );

  it("attaches the .png files of the qa-agent artifact that a stale qa-report.json does not name, in merge mode", async () => {
    staleReport();
    write("qa-agent/qa-artifacts/01-home.png", "png bytes");
    write("qa-agent/qa-artifacts/steps/02-detail.png", "png bytes");
    write("qa-agent/qa-artifacts/notes.txt", "not a screenshot");
    write("qa-agent/qa-claude-output.json", "{}");
    const result = await run("merge");
    expect(result.status).toBe(0);
    expect(uploaded().sort()).toEqual(["01-home.png", "02-detail.png"]);
    expect(commentText()).toContain("02-detail.png");
  });

  it("attaches the qa-agent .png files on a run where a check failed and the report names none", async () => {
    staleReport();
    write("qa-agent/qa-artifacts/01-home.png", "png bytes");
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(uploaded()).toEqual(["01-home.png"]);
  });

  it("attaches a screenshot named by the report and found in qa-artifacts only once", async () => {
    withQa(issueReport);
    await run("merge");
    expect(uploaded()).toEqual(["01-home.png", "02-detail.png"]);
  });

  it("does not attach a symlinked .png in qa-artifacts that points outside the artifacts", async () => {
    const outside = mkdtempSync(join(tmpdir(), "jira-evidence-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), "png bytes");
      write("qa-agent/qa-artifacts/01-home.png", "png bytes");
      symlinkSync(
        join(outside, "secret.png"),
        join(dir, "qa-agent/qa-artifacts/link.png"),
      );
      const result = await run("merge");
      expect(result.status).toBe(0);
      expect(uploaded()).toEqual(["01-home.png"]);
      expect(warnings(result.output).some((l) => l.includes("link.png"))).toBe(
        true,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("prints a warning naming the failure and exits 0 when Jira answers 401", async () => {
    withQa(passingReport);
    answerStatus = 401;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(result.output).toContain("::warning::jira-evidence:");
    expect(result.output).toContain("401");
  });

  it("prints a warning naming the key and exits 0 when the ticket does not exist", async () => {
    withQa(passingReport);
    answerStatus = 404;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(result.output).toContain("::warning::jira-evidence:");
    expect(result.output).toContain("404");
    expect(result.output).toContain("MBLPT-12");
  });

  it("posts nothing and exits 0 with a message for a branch without a ticket key", async () => {
    withQa(passingReport);
    const result = await run("run", { BRANCH: "fix-typo" });
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(0);
    expect(result.output).toContain("fix-typo");
  });

  it("posts nothing and exits 0 with a warning when JIRA_API_TOKEN is missing", async () => {
    withQa(passingReport);
    const result = await run("run", { JIRA_API_TOKEN: undefined });
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(0);
    expect(result.output).toContain("::warning::jira-evidence:");
    expect(result.output).toContain("JIRA_API_TOKEN");
  });

  it("sends basic auth built from JIRA_EMAIL and JIRA_API_TOKEN", async () => {
    withQa(issueReport);
    await run("run");
    const expected = `Basic ${Buffer.from("bot@example.com:secret-token").toString("base64")}`;
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests)
      expect(request.headers.authorization).toBe(expected);
  });

  it("keeps quotes and newlines from the QA report intact in the comment", async () => {
    const tricky = 'He said "stop"\nthen it\'s gone';
    withQa({
      ...passingReport,
      status: "product_issue",
      issues: [{ title: 'Button "Save"', detail: tricky }],
    });
    await run("run");
    const values = texts(JSON.parse(comments()[0].body).body);
    expect(values.some((value) => value.includes(tricky))).toBe(true);
    expect(values.some((value) => value.includes('Button "Save"'))).toBe(true);
  });

  it("posts one comment saying the checks were stopped by an earlier stage when the gate failed", async () => {
    withQa(issueReport);
    const result = await run("run", {
      GATE_RESULT: "failure",
      MAESTRO_RESULT: "skipped",
    });
    expect(result.status).toBe(0);
    expect(comments()).toHaveLength(1);
    expect(attachments()).toHaveLength(0);
    const text = commentText();
    expect(text).toContain("stopped by an earlier stage");
    expect(text).toContain("https://github.com/acme/app/actions/runs/99");
    expect(text).not.toContain("QA agent:");
  });

  it("uploads nothing for screenshot paths outside the artifacts or not .png, with a warning for each", async () => {
    write("qa-agent/qa-artifacts/notes.txt", "not a picture");
    withQa({
      ...passingReport,
      status: "product_issue",
      checked: [],
      issues: [
        { title: "One", detail: "a", screenshot: "../../etc/passwd" },
        { title: "Two", detail: "b", screenshot: "/etc/hosts" },
        { title: "Three", detail: "c", screenshot: "qa-artifacts/notes.txt" },
      ],
    });
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(attachments()).toHaveLength(0);
    expect(comments()).toHaveLength(1);
    const lines = warnings(result.output);
    expect(lines.some((line) => line.includes("../../etc/passwd"))).toBe(true);
    expect(lines.some((line) => line.includes("/etc/hosts"))).toBe(true);
    expect(lines.some((line) => line.includes("notes.txt"))).toBe(true);
  });

  it("uploads nothing for a symlink in the artifact that points at a .png outside the artifacts", async () => {
    const outside = mkdtempSync(join(tmpdir(), "jira-evidence-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), "png bytes");
      mkdirSync(join(dir, "qa-agent", "qa-artifacts"), { recursive: true });
      symlinkSync(
        join(outside, "secret.png"),
        join(dir, "qa-agent", "qa-artifacts", "link.png"),
      );
      withQa({
        ...passingReport,
        status: "product_issue",
        checked: [],
        issues: [
          { title: "One", detail: "a", screenshot: "qa-artifacts/link.png" },
        ],
      });
      const result = await run("run");
      expect(result.status).toBe(0);
      expect(attachments()).toHaveLength(0);
      expect(comments()).toHaveLength(1);
      expect(
        warnings(result.output).some(
          (line) =>
            line.includes("qa-artifacts/link.png") &&
            line.includes("outside the artifacts"),
        ),
      ).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("posts nothing and exits 0 with a warning naming the project when the ticket belongs to another project", async () => {
    withQa(passingReport);
    const result = await run("run", { JIRA_PROJECT_KEY: "ACME" });
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(0);
    expect(warnings(result.output).some((line) => line.includes("ACME"))).toBe(
      true,
    );
  });

  it("posts to the ticket named after the feat/ prefix of the branch", async () => {
    withQa(passingReport);
    const result = await run("run", { BRANCH: "feat/MBLPT-12-x" });
    expect(result.status).toBe(0);
    expect(comments()).toHaveLength(1);
  });

  it("posts to the ticket named at the start of a branch with no type prefix", async () => {
    withQa(passingReport);
    const result = await run("run", { BRANCH: "MBLPT-12-agents-md" });
    expect(result.status).toBe(0);
    expect(comments()).toHaveLength(1);
  });

  it("posts when the ticket belongs to the configured project", async () => {
    withQa(passingReport);
    const result = await run("run", { JIRA_PROJECT_KEY: "MBLPT" });
    expect(result.status).toBe(0);
    expect(comments()).toHaveLength(1);
  });

  it("says the QA agent has no report when the qa-report folder is missing", async () => {
    write("maestro-android/maestro-report-1.xml", junit(1, 0));
    await run("run");
    expect(commentText()).toContain("QA agent: no report");
  });

  it("names the tooling failure from qa-report.json", async () => {
    write(
      "qa-report/qa-report.json",
      JSON.stringify({
        status: "inconclusive",
        check: "fail",
        tooling_failure: "the agent output was not valid JSON",
        summary: "",
        checked: [],
        issues: [],
        tooling_notes: [],
      }),
    );
    await run("run");
    expect(commentText()).toContain(
      "QA agent: inconclusive (tooling failure: the agent output was not valid JSON)",
    );
  });

  it("warns and still posts the comment when qa-report.json is not valid JSON", async () => {
    write("qa-report/qa-report.json", "{ not json");
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(
      warnings(result.output).some((line) => line.includes("qa-report.json")),
    ).toBe(true);
    expect(comments()).toHaveLength(1);
    expect(commentText()).toContain("QA agent: no report");
  });

  it("says Maestro was skipped when its job was skipped", async () => {
    withQa(passingReport);
    await run("run", { MAESTRO_RESULT: "skipped" });
    expect(commentText()).toContain("Maestro: skipped");
  });

  it("warns and still posts the comment, with no attached list, when the upload is refused", async () => {
    withQa(issueReport);
    attachmentStatus = 403;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(attachments()).toHaveLength(2);
    expect(
      warnings(result.output).some(
        (line) =>
          line.includes("uploading screenshot 01-home.png") &&
          line.includes("403"),
      ),
    ).toBe(true);
    expect(comments()).toHaveLength(1);
    expect(commentText()).toContain("QA agent: product issue");
    expect(commentText()).not.toContain("Attached screenshots");
  });

  it("warns and posts nothing in merge mode when the evidence folder is empty", async () => {
    const result = await run("merge");
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(0);
    expect(
      warnings(result.output).some(
        (line) =>
          line.includes("no screenshots") &&
          line.includes("took none") &&
          line.includes("expired"),
      ),
    ).toBe(true);
  });

  it("warns and posts no comment in merge mode when the upload fails", async () => {
    withQa(issueReport);
    attachmentStatus = 500;
    const result = await run("merge");
    expect(result.status).toBe(0);
    expect(attachments()).toHaveLength(2);
    expect(comments()).toHaveLength(0);
    expect(warnings(result.output).some((line) => line.includes("500"))).toBe(
      true,
    );
  });

  it("attaches the other screenshots when Jira refuses one, and names the refused one in the comment", async () => {
    withQa(issueReport);
    tooLarge = "01-home.png";
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(uploaded()).toEqual(["01-home.png", "02-detail.png"]);
    expect(
      warnings(result.output).some(
        (line) => line.includes("01-home.png") && line.includes("413"),
      ),
    ).toBe(true);
    const text = commentText();
    expect(text).toMatch(/Attached screenshots:\n02-detail\.png/);
    expect(text).toMatch(/did not take[^\n]*\n01-home\.png/);
  });

  it("names only the screenshots that were taken in merge mode when Jira refuses one", async () => {
    withQa(issueReport);
    tooLarge = "02-detail.png";
    const result = await run("merge");
    expect(result.status).toBe(0);
    expect(comments()).toHaveLength(1);
    const text = commentText();
    expect(text).toMatch(/Attached screenshots:\n01-home\.png/);
    expect(text).toMatch(/did not take[^\n]*\n02-detail\.png/);
  });

  it("stops uploading at the first upload Jira does not answer, and still posts the comment naming every screenshot", async () => {
    withQa(issueReport);
    hangUpOnUpload = true;
    const result = await run("run");
    expect(result.status).toBe(0);
    expect(attachments()).toHaveLength(1);
    expect(comments()).toHaveLength(1);
    const text = commentText();
    expect(text).not.toContain("Attached screenshots");
    expect(text).toMatch(/did not take[^\n]*\n01-home\.png\n02-detail\.png/);
  });
});
