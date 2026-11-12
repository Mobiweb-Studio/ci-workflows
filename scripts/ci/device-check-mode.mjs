// Decides whether a device check (the Maestro flows or the QA agent) runs for a pull request, and why.
// The rules and the path lists live here only, so they can be tested before a workflow relies on them.
//
//   node scripts/ci/device-check-mode.mjs decide    prints "run=<true|false>" and "reason=<slug>" for one check
//   node scripts/ci/device-check-mode.mjs comment   prints the text of the mode comment, for both checks
//   node scripts/ci/device-check-mode.mjs tags      prints "tags=<tags>" (empty: every flow) and "tags-reason=<slug>":
//                                                   the Maestro flows the change affects (ADR 0022 in ICligo)
//
// Inputs come from the environment: CHECK (maestro or qa; decide only), BASE_REF, DEFAULT_BRANCH, IS_DRAFT
// (true or false), LABELS (one label per line), EVENT_ACTION, EVENT_LABEL (the label a labeled or unlabeled
// event is about), BASE_CHANGED (true when an edit changed the base branch) and CHANGED_FILES (the path of a
// file that lists the changed files, one per line). A missing or invalid input stops with an error: the script
// never falls back to skipping a check.
//
// The impact map, IMPACT_FILE (default `.maestro/IMPACT`, read from the working directory, the project's checkout),
// is optional. One line per rule, as in CODEOWNERS: a path glob from the repository root, then the flow tags a change
// there affects (`src/pages/login/** login`); `#` starts a comment. `*` matches within a folder, `**` across
// folders, and a glob ending in `/` matches everything below it. A tag `*` means every flow. Every matching line
// counts, not only the last. Without the map, or when one changed app file matches no line, every flow runs: the
// map can narrow a run, never hide a change it does not know. The flows tagged `smoke` always run.
import { existsSync, readFileSync } from "node:fs";

const LABEL = {
  skip: "skip-device-checks",
  story: "us",
  onDemand: "run-device-checks",
};
// The three labels that steer the checks, plus `no-docs`: it does not change whether a check runs, but adding or
// removing it re-runs `docs-check`, so the gate has to look again (ADR 0018). Any other label never restarts a
// device job, because the skipped run it would start could hide an earlier red one.
const RELEVANT_LABELS = [...Object.values(LABEL), "no-docs"];

// The files that can change what each check tests: the grep patterns the two old workflows used, plus the files
// that decide how the APK is built and which checks run (the caller workflow, which holds the inputs). A change to any of them is a change to the app or to the check itself.
const CHECKS = {
  maestro: {
    name: "maestro-android",
    paths: new RegExp(
      String.raw`^(src/|app/|vendors/|\.maestro/|app\.config\.ts$|metro\.config\.js$|jest\.config\.js$|babel\.config\.js$|index\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|\.nvmrc$|tsconfig\.json$|\.github/workflows/device-checks\.yml$)`,
    ),
  },
  qa: {
    name: "qa-agent",
    paths: new RegExp(
      String.raw`^(src/|app/|vendors/|app\.config\.ts$|metro\.config\.js$|jest\.config\.js$|babel\.config\.js$|index\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|\.nvmrc$|tsconfig\.json$|scripts/agent-qa/|\.github/workflows/device-checks\.yml$)`,
    ),
  },
};

function fail(message) {
  console.error(`device-check-mode: ${message}`);
  process.exit(2);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

function flag(name, { optional = false } = {}) {
  const value = process.env[name];
  if (optional && (value === undefined || value === "")) return false;
  if (value !== "true" && value !== "false")
    fail(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
  return value === "true";
}

const lines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function readInput() {
  let changedFiles;
  try {
    changedFiles = lines(readFileSync(required("CHANGED_FILES"), "utf8"));
  } catch (error) {
    if (error.code === undefined) throw error;
    fail(`cannot read the changed-file list: ${error.message}`);
  }
  const action = required("EVENT_ACTION");
  const label = (process.env.EVENT_LABEL ?? "").trim();
  if ((action === "labeled" || action === "unlabeled") && label === "") {
    fail(`EVENT_LABEL is not set for a ${action} event`);
  }
  return {
    baseRef: required("BASE_REF"),
    defaultBranch: required("DEFAULT_BRANCH"),
    draft: flag("IS_DRAFT"),
    labels: lines(process.env.LABELS ?? ""),
    action,
    label,
    baseChanged: flag("BASE_CHANGED", { optional: true }),
    changedFiles,
  };
}

// A label that is not one of the three never starts a device check. Only the decision for a single check
// uses this: the mode comment describes the PR as it is, whatever event started the workflow.
function isUnrelatedLabelEvent(input) {
  const labelEvent = input.action === "labeled" || input.action === "unlabeled";
  return labelEvent && !RELEVANT_LABELS.includes(input.label);
}

// The first rule that matches decides, so the order is the precedence.
function decide(check, input) {
  const intoDefault = input.baseRef === input.defaultBranch;
  const has = (label) => input.labels.includes(label);

  if (!input.changedFiles.some((file) => check.paths.test(file)))
    return { run: false, reason: "no-app-changes" };
  if (!intoDefault) {
    return has(LABEL.onDemand)
      ? { run: true, reason: "on-demand" }
      : { run: false, reason: "other-base" };
  }
  if (input.draft) return { run: false, reason: "draft" };
  if (has(LABEL.story)) return { run: true, reason: "story-pr" };
  if (has(LABEL.skip)) return { run: false, reason: "skipped-by-label" };
  return { run: true, reason: "full" };
}

const IMPACT_FILE_DEFAULT = ".maestro/IMPACT";
const ALWAYS_TAG = "smoke";
const ALL_TAG = "*";

function globToRegex(glob) {
  let pattern = glob.replace(/^\//, "");
  const below = pattern.endsWith("/");
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
    } else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}${below ? ".*" : ""}$`);
}

// The impact map's rules, or null when the project has none.
function readImpact() {
  const path = process.env.IMPACT_FILE || IMPACT_FILE_DEFAULT;
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [glob, ...tags] = line.split(/\s+/);
      if (tags.length === 0)
        fail(`the impact map line "${line}" names no flow tag`);
      return { glob, regex: globToRegex(glob), tags };
    });
}

// Which flows the change affects: `tags` empty means every flow.
function chooseTags(input, impact) {
  if (impact === null) return { tags: [], reason: "no-impact-map" };
  if (input.labels.includes(LABEL.story))
    return { tags: [], reason: "story-pr" };
  const tags = new Set([ALWAYS_TAG]);
  for (const file of input.changedFiles) {
    if (!CHECKS.maestro.paths.test(file)) continue;
    const rules = impact.filter((rule) => rule.regex.test(file));
    if (rules.length === 0) return { tags: [], reason: "unmapped", file };
    for (const rule of rules) {
      if (rule.tags.includes(ALL_TAG))
        return { tags: [], reason: "maps-to-all", file };
      for (const tag of rule.tags) tags.add(tag);
    }
  }
  return { tags: [...tags], reason: "impact" };
}

function describeTags(choice) {
  const map = `\`${process.env.IMPACT_FILE || IMPACT_FILE_DEFAULT}\``;
  switch (choice.reason) {
    case "impact":
      return `the flows tagged ${choice.tags.map((tag) => `\`${tag}\``).join(", ")} (${map})`;
    case "unmapped":
      return `every flow: \`${choice.file}\` is not in ${map}`;
    case "maps-to-all":
      return `every flow: ${map} maps \`${choice.file}\` to all of them`;
    default:
      return null;
  }
}

function describe(decision, input, check) {
  switch (decision.reason) {
    case "full": {
      const tags =
        check === CHECKS.maestro
          ? describeTags(chooseTags(input, readImpact()))
          : null;
      return tags ? `runs ${tags}` : "full run";
    }
    case "story-pr":
      return "full run (story PR)";
    case "on-demand":
      return `runs on demand (\`${LABEL.onDemand}\`)`;
    case "skipped-by-label":
      return `skipped by the \`${LABEL.skip}\` label`;
    case "draft":
      return "not run yet, the PR is a draft";
    case "no-app-changes":
      return "not needed, no app files changed";
    case "other-base":
      return `does not run, the PR targets \`${input.baseRef}\` and not \`${input.defaultBranch}\``;
    default:
      throw new Error(`no description for the reason "${decision.reason}"`);
  }
}

function renderComment(input) {
  const text = ["**Device checks**", ""];
  for (const check of Object.values(CHECKS)) {
    text.push(
      `- \`${check.name}\`: ${describe(decide(check, input), input, check)}`,
    );
  }
  if (
    input.action === "edited" &&
    input.baseChanged &&
    input.baseRef === input.defaultBranch
  ) {
    text.push(
      "",
      `This PR was retargeted to \`${input.defaultBranch}\`. The retarget does not start the checks: push a commit or re-run the workflows.`,
    );
  }
  return `${text.join("\n")}\n`;
}

const command = process.argv[2];
if (command === "decide") {
  const checkName = required("CHECK");
  if (!Object.hasOwn(CHECKS, checkName))
    fail(
      `CHECK must be one of ${Object.keys(CHECKS).join(", ")}, got "${checkName}"`,
    );
  const input = readInput();
  const decision = isUnrelatedLabelEvent(input)
    ? { run: false, reason: "unrelated-label" }
    : decide(CHECKS[checkName], input);
  process.stdout.write(`run=${decision.run}\nreason=${decision.reason}\n`);
} else if (command === "comment") {
  process.stdout.write(renderComment(readInput()));
} else if (command === "tags") {
  const choice = chooseTags(readInput(), readImpact());
  process.stdout.write(
    `tags=${choice.tags.join(" ")}\ntags-reason=${choice.reason}\n`,
  );
} else {
  fail(`unknown command "${command ?? ""}", use "decide", "comment" or "tags"`);
}
