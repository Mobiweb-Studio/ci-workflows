// Decides what a valid Jira ticket key is, for the `ticket-key` check in ci.yml and for the Jira evidence poster,
// which imports `parseTicketKey`.
//
//   node scripts/ci/ticket-key.mjs check   on a feat/ or fix/ branch, fails unless the branch has a ticket key right
//                                          after the prefix and the PR title starts with the same key
//
// Only feature and bug-fix branches need a key, so chore/, docs/, ci/, release-please and Dependabot branches pass.
// Examples: branch feat/MBLPT-12-short-name, title "MBLPT-12 Short summary".
//
// Inputs come from the environment: BRANCH (the head branch), TITLE (the PR title) and, optionally,
// JIRA_PROJECT_KEY (for example MBLPT). When JIRA_PROJECT_KEY is set, only keys of that project pass.
import { fileURLToPath } from "node:url";

// A key ends the branch name or is followed by `-`, and ends the title or is followed by a space, so
// `MBLPT-12abc` is not read as MBLPT-12. A branch may put one `<type>/` prefix of lowercase letters before the key.
const PATTERN = {
  branch: "^(?:[a-z]+/)?([A-Z][A-Z0-9]+-[0-9]+)(?=-|$)",
  title: "^([A-Z][A-Z0-9]+-[0-9]+)(?= |$)",
};

// Returns the ticket key a branch name or PR title starts with, or null when there is none, or when
// `projectKey` is given and the key belongs to another project.
export function parseTicketKey(value, kind, projectKey) {
  const match = new RegExp(PATTERN[kind]).exec(value);
  if (match === null) return null;
  const key = match[1];
  if (projectKey && !key.startsWith(`${projectKey}-`)) return null;
  return key;
}

function fail(message) {
  console.error(`ticket-key: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

function check() {
  const projectKey = process.env.JIRA_PROJECT_KEY || undefined;
  const branch = required("BRANCH");
  const title = required("TITLE");
  const prefix = /^(feat|fix)\//.exec(branch);
  if (prefix === null) {
    console.log(
      `ticket-key: no ticket key is required for branch ${branch}, only feat/ and fix/ branches need one`,
    );
    return;
  }
  const key = projectKey
    ? `a Jira ticket key of project ${projectKey}`
    : "a Jira ticket key";
  const example = projectKey ?? "MBLPT";
  const branchKey = parseTicketKey(branch, "branch", projectKey);
  if (branchKey === null) {
    fail(
      `Branch name must have ${key} after ${prefix[0]}, for example ${prefix[0]}${example}-12-short-name. Got: ${branch}`,
    );
  }
  if (parseTicketKey(title, "title", projectKey) !== branchKey) {
    fail(
      `PR title must start with the branch's key ${branchKey}, for example "${branchKey} Short summary". Got: ${title}`,
    );
  }
}

// Runs only as a command, so importing the parser has no side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "check") check();
  else fail(`unknown command "${command ?? ""}", use "check"`);
}
