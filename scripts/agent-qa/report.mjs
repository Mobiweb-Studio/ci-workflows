// Turns the QA agent's run into a PR comment and a pass/fail decision.
// Reads qa-claude-transcript.jsonl (one event per line; the last is the result) and writes qa-comment.md,
// qa-status.txt and qa-report.json (the same verdict as data, for the Jira evidence job).
// Env: HAS_ACK ("true" when the PR has the qa-acknowledged label), ARTIFACT_URL, RUN_URL, QA_MAX_BUDGET_USD (the
// cost ceiling the agent ran with, default 0.50).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const COST_CEILING_USD = Number(process.env.QA_MAX_BUDGET_USD || 0.5);
const STATUSES = ["pass", "product_issue", "inconclusive"];

const acknowledged = process.env.HAS_ACK === "true";
const artifactUrl = process.env.ARTIFACT_URL ?? "";
const runUrl = process.env.RUN_URL ?? "";

function readEvents() {
  if (!existsSync("qa-claude-transcript.jsonl")) return null;
  const events = [];
  for (const line of readFileSync("qa-claude-transcript.jsonl", "utf8").split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // A blank or cut line says nothing; the result event is checked below.
    }
  }
  return events;
}

function readAgentOutput(events) {
  if (events === null) {
    return { error: "the agent produced no transcript" };
  }
  const outer = events.findLast((event) => event?.type === "result");
  if (!outer) {
    return { error: "the agent run ended without a result" };
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

// Sign-ins that cannot have happened, whatever the agent reports: it typed a variable's name instead of its value, or
// qa-fill-secret failed. On PR #165 the agent typed MAESTRO_REAL_TP_IDENTIFIER into the login and reported a pass.
function signInMistake(events) {
  const commands = new Map();
  for (const event of events ?? []) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && typeof block.input?.command === "string") {
        commands.set(block.id, block.input.command.trim());
        const name = block.input.command.match(/^agent-device\s+(?:fill|type)\b.*\b(MAESTRO_[A-Z0-9_]+)\b/s)?.[1];
        if (name) {
          return `it typed the name ${name} with agent-device instead of filling the value with qa-fill-secret, so it never signed in`;
        }
      }
      if (block.type === "tool_result" && block.is_error) {
        const command = commands.get(block.tool_use_id) ?? "";
        if (command.startsWith("qa-fill-secret")) {
          const text = Array.isArray(block.content)
            ? block.content.map((part) => part.text ?? "").join(" ")
            : String(block.content ?? "");
          const reason = text.split("\n").find((line) => line.trim()) ?? "no output";
          return `\`${command}\` failed (${reason.trim()}), so it never signed in`;
        }
      }
    }
  }
  return null;
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

const events = readEvents();
const { report, error: readError, usage = {} } = readAgentOutput(events);
const mistake = signInMistake(events);
const valid = isValid(report) && !mistake;
const error =
  mistake ?? readError ?? "the agent report did not match the expected shape";
const status = valid ? report.status : "inconclusive";

const lines = ["<!-- qa-agent -->", "## QA agent report", ""];
if (valid) {
  const result =
    status === "inconclusive"
      ? acknowledged
        ? "tooling failure (acknowledged)"
        : "fail (tooling)"
      : status.replace("_", " ");
  lines.push(`**Result: ${result}**`, "", report.summary, "");
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
    `**Result: ${acknowledged ? "tooling failure (acknowledged)" : "fail (tooling)"}**`,
    "",
    `The QA agent's run cannot be used: ${error}. This says nothing about the change.`,
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
    "A tooling failure fails this check until a reviewer adds the `qa-acknowledged` label and re-runs the job.",
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
