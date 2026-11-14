import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "report.mjs");

const passReport = {
  status: "pass",
  summary: "The list and the detail screen work.",
  checked: [
    {
      screen: "Items",
      expectation: "The list shows items",
      result: "ok",
      screenshot: "qa-artifacts/1-items.png",
    },
  ],
  issues: [],
  tooling_notes: [],
};

const issueReport = {
  status: "product_issue",
  summary: "The detail screen shows no title.",
  checked: [
    {
      screen: "Detail",
      expectation: "The title is shown",
      result: "problem",
      screenshot: "qa-artifacts/2-detail.png",
    },
  ],
  issues: [
    {
      title: "Missing title",
      detail: "The detail screen is blank at the top.",
      screenshot: "qa-artifacts/2-detail.png",
    },
  ],
  tooling_notes: ["The first tap needed a retry."],
};

const inconclusiveReport = {
  status: "inconclusive",
  summary: "The emulator did not start the app.",
  checked: [],
  issues: [],
};

// The result event claude -p --output-format stream-json writes last, with the agent's report as its result text.
function resultEvent(report: object) {
  return JSON.stringify({
    duration_ms: 95400,
    type: "result",
    is_error: false,
    result: JSON.stringify(report),
    total_cost_usd: 0.123,
    num_turns: 12,
  });
}

// A tool call and its output, as the transcript records them.
function toolCall(id: string, command: string) {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
}
function toolOutput(id: string, text: string, isError = false) {
  return JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content: text, is_error: isError },
      ],
    },
  });
}

// The transcript of a run: the init event, the given events, and the result.
function claudeOutput(report: object, events: string[] = []) {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    ...events,
    resultEvent(report),
    "",
  ].join("\n");
}

describe("report.mjs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qa-report-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(output: string | null, env: Record<string, string> = {}) {
    if (output !== null) {
      writeFileSync(join(dir, "qa-claude-transcript.jsonl"), output);
    }
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: {
        ...process.env,
        HAS_ACK: "",
        RUN_URL: "https://github.com/o/r/actions/runs/1",
        ARTIFACT_URL: "https://github.com/o/r/actions/runs/1/artifacts/2",
        ...env,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    return {
      comment: read("qa-comment.md"),
      status: read("qa-status.txt"),
      json: existsSync(join(dir, "qa-report.json"))
        ? JSON.parse(read("qa-report.json"))
        : undefined,
    };
  }

  describe("the PR comment and status, as before qa-report.json", () => {
    it("writes a passing comment with the checked table", () => {
      const { comment, status } = run(claudeOutput(passReport));
      expect(comment).toBe(
        [
          "<!-- qa-agent -->",
          "## QA agent report",
          "",
          "**Result: pass**",
          "",
          "The list and the detail screen work.",
          "",
          "| Screen | Expectation | Result |",
          "|---|---|---|",
          "| Items | The list shows items | ok |",
          "",
          "",
          "Screenshots: https://github.com/o/r/actions/runs/1/artifacts/2",
          "Run: https://github.com/o/r/actions/runs/1",
          "Usage: 12 turns, 95 s, model cost $0.123 (ceiling $0.50).",
          "",
        ].join("\n"),
      );
      expect(status).toBe("pass\n");
    });

    it("lists issues and tooling notes and fails on a product issue", () => {
      const { comment, status } = run(claudeOutput(issueReport));
      expect(comment).toContain("**Result: product issue**");
      expect(comment).toContain(
        "- **Missing title**: The detail screen is blank at the top.\n- Tooling: The first tap needed a retry.\n",
      );
      expect(status).toBe("fail\n");
    });

    it("fails an inconclusive run without the acknowledgement label", () => {
      const { comment, status } = run(claudeOutput(inconclusiveReport));
      expect(comment).toContain("**Result: fail (tooling)**");
      expect(comment).toContain(
        "A tooling failure fails this check until a reviewer adds the `qa-acknowledged` label and re-runs the job.",
      );
      expect(status).toBe("fail\n");
    });

    it("passes an inconclusive run with the acknowledgement label", () => {
      const { comment, status } = run(claudeOutput(inconclusiveReport), {
        HAS_ACK: "true",
      });
      expect(comment).toContain("**Result: tooling failure (acknowledged)**");
      expect(comment).not.toContain("qa-acknowledged");
      expect(status).toBe("pass\n");
    });

    it("reports a tooling failure when the transcript has no result", () => {
      const { comment, status } = run("not json");
      expect(comment).toContain(
        "**Result: fail (tooling)**\n\nThe QA agent's run cannot be used: the agent run ended without a result. This says nothing about the change.",
      );
      expect(comment).toContain("Usage: ? turns, ? s, model cost unknown");
      expect(status).toBe("fail\n");
    });

    it("reports a tooling failure when there is no transcript", () => {
      const { comment } = run(null);
      expect(comment).toContain("the agent produced no transcript");
    });

    it("reads the last result event of the transcript", () => {
      const first = resultEvent(issueReport);
      const { comment } = run(`${first}\n${claudeOutput(passReport)}`);
      expect(comment).toContain("**Result: pass**");
    });

    it("warns when the run passed the cost ceiling", () => {
      const output = JSON.parse(resultEvent(passReport));
      const { comment } = run(
        JSON.stringify({ ...output, total_cost_usd: 0.75 }),
      );
      expect(comment).toContain(
        "**Warning: the run passed the $0.50 cost ceiling.**",
      );
    });

    it("reads the cost ceiling the agent ran with", () => {
      const output = JSON.parse(resultEvent(passReport));
      const { comment } = run(
        JSON.stringify({ ...output, total_cost_usd: 0.75 }),
        { QA_MAX_BUDGET_USD: "5" },
      );
      expect(comment).toContain("model cost $0.750 (ceiling $5.00).");
      expect(comment).not.toContain("Warning");
    });
  });

  describe("qa-report.json", () => {
    it("records a pass with its checked items and no issues", () => {
      const { json } = run(claudeOutput(passReport));
      expect(json).toEqual({
        status: "pass",
        check: "pass",
        tooling_failure: null,
        summary: passReport.summary,
        checked: passReport.checked,
        issues: [],
        tooling_notes: [],
      });
    });

    it("lists each product issue with its screenshot path", () => {
      const { json } = run(claudeOutput(issueReport));
      expect(json.status).toBe("product_issue");
      expect(json.check).toBe("fail");
      expect(json.issues).toEqual([
        {
          title: "Missing title",
          detail: "The detail screen is blank at the top.",
          screenshot: "qa-artifacts/2-detail.png",
        },
      ]);
      expect(json.tooling_notes).toEqual(["The first tap needed a retry."]);
    });

    it("records an unacknowledged inconclusive run as failing the check", () => {
      const { json } = run(claudeOutput(inconclusiveReport));
      expect(json.status).toBe("inconclusive");
      expect(json.check).toBe("fail");
      expect(json.tooling_failure).toBeNull();
    });

    it("marks a tooling failure when the agent output cannot be read", () => {
      const { json } = run("not json");
      expect(json).toEqual({
        status: "inconclusive",
        check: "fail",
        tooling_failure: "the agent run ended without a result",
        summary: "",
        checked: [],
        issues: [],
        tooling_notes: [],
      });
    });

    it("names the shape mismatch in the comment and the report when the status is not a known one", () => {
      const { comment, json } = run(
        claudeOutput({ ...passReport, status: "done" }),
      );
      const message = "the agent report did not match the expected shape";
      expect(comment).toContain(
        `The QA agent's run cannot be used: ${message}. This says nothing about the change.`,
      );
      expect(json.status).toBe("inconclusive");
      expect(json.tooling_failure).toBe(message);
    });
  });

  describe("a sign-in that cannot have happened", () => {
    it("fails a reported pass when the agent typed a variable's name with agent-device", () => {
      const { comment, status, json } = run(
        claudeOutput(passReport, [
          toolCall("t1", "agent-device fill @e5 MAESTRO_REAL_TP_IDENTIFIER --settle"),
          toolOutput("t1", "Filled @e5"),
        ]),
      );
      const message =
        "it typed the name MAESTRO_REAL_TP_IDENTIFIER with agent-device instead of filling the value with qa-fill-secret, so it never signed in";
      expect(comment).toContain(
        `**Result: fail (tooling)**\n\nThe QA agent's run cannot be used: ${message}. This says nothing about the change.`,
      );
      expect(status).toBe("fail\n");
      expect(json.status).toBe("inconclusive");
      expect(json.tooling_failure).toBe(message);
    });

    it("fails a reported pass when qa-fill-secret failed", () => {
      const { comment, status } = run(
        claudeOutput(passReport, [
          toolCall("t1", "qa-fill-secret @e7 MAESTRO_REAL_TP_PASSWORD"),
          toolOutput(
            "t1",
            "MAESTRO_REAL_TP_PASSWORD is not set: the project's MAESTRO_ENV secret has no value for it.",
            true,
          ),
        ]),
      );
      expect(comment).toContain(
        "`qa-fill-secret @e7 MAESTRO_REAL_TP_PASSWORD` failed (MAESTRO_REAL_TP_PASSWORD is not set: the project's MAESTRO_ENV secret has no value for it.), so it never signed in",
      );
      expect(status).toBe("fail\n");
    });

    it("keeps a pass when the agent signed in with qa-fill-secret", () => {
      const { comment, status } = run(
        claudeOutput(passReport, [
          toolCall("t1", "qa-fill-secret id=login-identifier-input MAESTRO_REAL_TP_IDENTIFIER"),
          toolOutput("t1", "Filled id=login-identifier-input"),
          toolCall("t2", "agent-device fill @e9 qa-agent-unknown@icligo.test --settle"),
          toolOutput("t2", "Filled @e9"),
          toolCall("t3", "agent-device wait text \"MAESTRO\""),
          toolOutput("t3", "timed out", true),
        ]),
      );
      expect(comment).toContain("**Result: pass**");
      expect(status).toBe("pass\n");
    });
  });
});
