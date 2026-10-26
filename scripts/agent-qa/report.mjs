// Turns the QA agent's output into a PR comment and a pass/fail decision.
// Reads qa-claude-output.json and writes qa-comment.md, qa-status.txt and qa-report.json (the same verdict as
// data, for the Jira evidence job).
// Env: HAS_ACK ("true" when the PR has the qa-acknowledged label), ARTIFACT_URL, RUN_URL.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const COST_CEILING_USD = 0.5;
const STATUSES = ["pass", "product_issue", "inconclusive"];

const acknowledged = process.env.HAS_ACK === "true";
const artifactUrl = process.env.ARTIFACT_URL ?? "";
const runUrl = process.env.RUN_URL ?? "";

function readAgentOutput() {
  if (!existsSync("qa-claude-output.json")) {
    return { error: "the agent produced no output file" };
  }
  let outer;
  try {
    outer = JSON.parse(readFileSync("qa-claude-output.json", "utf8"));
  } catch {
    return { error: "the agent output was not valid JSON" };
  }
  const usage = {
    costUsd: outer.total_cost_usd,
    turns: outer.num_turns,
    seconds: outer.duration_ms
      ? Math.round(outer.duration_ms / 1000)
      : undefined,
  };
  if (outer.is_error || typeof outer.result !== "string") {
    return { error: outer.subtype ?? "the agent run failed", usage };
  }
  const start = outer.result.indexOf("{");
  const end = outer.result.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return { error: "the agent did not return a JSON report", usage };
  }
  try {
    return { report: JSON.parse(outer.result.slice(start, end + 1)), usage };
  } catch {
    return { error: "the agent report was not valid JSON", usage };
  }
}

function isValid(report) {
  return (
    report &&
    STATUSES.includes(report.status) &&
    typeof report.summary === "string" &&
    Array.isArray(report.checked) &&
    Array.isArray(report.issues)
  );
}

const { report, error: readError, usage = {} } = readAgentOutput();
const valid = isValid(report);
const error = readError ?? "the agent report did not match the expected shape";
const status = valid ? report.status : "inconclusive";

const lines = ["<!-- qa-agent -->", "## QA agent report", ""];
if (valid) {
  lines.push(`**Result: ${status.replace("_", " ")}**`, "", report.summary, "");
  if (report.checked.length > 0) {
    lines.push("| Screen | Expectation | Result |", "|---|---|---|");
    for (const item of report.checked) {
      lines.push(`| ${item.screen} | ${item.expectation} | ${item.result} |`);
    }
    lines.push("");
  }
  for (const issue of report.issues) {
    lines.push(`- **${issue.title}**: ${issue.detail}`);
  }
  for (const note of report.tooling_notes ?? []) {
    lines.push(`- Tooling: ${note}`);
  }
} else {
  lines.push(
    "**Result: inconclusive (tooling failure)**",
    "",
    `The QA agent did not produce a usable report: ${error}. This says nothing about the change.`,
  );
}
lines.push("");
if (artifactUrl) lines.push(`Screenshots: ${artifactUrl}`);
if (runUrl) lines.push(`Run: ${runUrl}`);
const cost =
  typeof usage.costUsd === "number"
    ? `$${usage.costUsd.toFixed(3)}`
    : "unknown";
lines.push(
  `Usage: ${usage.turns ?? "?"} turns, ${usage.seconds ?? "?"} s, model cost ${cost} (ceiling $${COST_CEILING_USD.toFixed(2)}).`,
);
if (typeof usage.costUsd === "number" && usage.costUsd > COST_CEILING_USD) {
  lines.push(
    "",
    `**Warning: the run passed the $${COST_CEILING_USD.toFixed(2)} cost ceiling.**`,
  );
}
if (status === "inconclusive" && !acknowledged) {
  lines.push(
    "",
    "An inconclusive run fails this check until a reviewer adds the `qa-acknowledged` label and re-runs the job.",
  );
}

writeFileSync("qa-comment.md", `${lines.join("\n")}\n`);

const passes = status === "pass" || (status === "inconclusive" && acknowledged);
writeFileSync("qa-status.txt", passes ? "pass\n" : "fail\n");
// Screenshot paths stay as the agent wrote them: relative to the workspace, under qa-artifacts/.
const data = {
  status,
  check: passes ? "pass" : "fail",
  tooling_failure: valid ? null : error,
  summary: valid ? report.summary : "",
  checked: valid ? report.checked : [],
  issues: valid ? report.issues : [],
  tooling_notes: valid ? (report.tooling_notes ?? []) : [],
};
writeFileSync("qa-report.json", `${JSON.stringify(data, null, 2)}\n`);
console.log(`QA agent status: ${status}${passes ? "" : " (check fails)"}`);
