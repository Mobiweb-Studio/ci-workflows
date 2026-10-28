// Decides whether a pull request needs a person's review before it can merge, for the `human-review` check.
//
//   node scripts/ci/human-review.mjs    exits 0 when the pull request may merge without waiting for a person, or a
//                                       person already approved its head commit; exits 1 otherwise
//
// A pull request passes without a person only when both hold:
//   - an agent review comment exists for the pull request's current head commit. The comment holds the marker
//     `<!-- MARKER: HEAD_SHA -->`, and its author is the repository's owner, a member or a collaborator, so
//     a drive-by comment cannot satisfy it. A new push changes the head, so it needs a new review.
//   - the label was never applied. Removing the label does not reopen this path: the history of the pull
//     request is read, not its current labels.
// Otherwise it passes only with an approving review of the current head commit from a person, other than the
// pull request's author, whose permission on the repository is one of APPROVER_PERMISSIONS.
//
// Paths that need an owner by rule (CODEOWNERS risk paths) are enforced by the ruleset, not here.
//
// Inputs come from the environment: REPOSITORY (owner/name), PR_NUMBER, HEAD_SHA, PR_AUTHOR, and optionally
// LABEL (default needs-human-review), MARKER (default ce-code-review) and APPROVER_PERMISSIONS (default
// admin,maintain,write), plus GH_TOKEN for gh. Anything the API cannot read makes the check fail, never pass.
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`human-review: ${message}\n`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`${name} is required`);
  return value.trim();
}

const repository = required("REPOSITORY");
const number = required("PR_NUMBER");
const head = required("HEAD_SHA");
const author = required("PR_AUTHOR");
const label = process.env.LABEL?.trim() || "needs-human-review";
const marker = process.env.MARKER?.trim() || "ce-code-review";
const permissions = (process.env.APPROVER_PERMISSIONS?.trim() || "admin,maintain,write")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// The lines `gh api --paginate --jq` prints, one JSON object each, or null when the call failed.
function readLines(path, jq) {
  const result = spawnSync("gh", ["api", "--paginate", path, "--jq", jq], {
    encoding: "utf8",
  });
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

const comments = readLines(
  `repos/${repository}/issues/${number}/comments`,
  ".[] | {body, association: .author_association}",
);
const events = readLines(
  `repos/${repository}/issues/${number}/events`,
  '.[] | select(.event == "labeled") | {label: .label.name}',
);
const reviews = readLines(
  `repos/${repository}/pulls/${number}/reviews`,
  ".[] | {user: .user.login, state, commit: .commit_id}",
);
if (comments === null || events === null || reviews === null)
  fail("the pull request could not be read from the API");

const reviewers = ["OWNER", "MEMBER", "COLLABORATOR"];
const marked = comments.some(
  ({ body, association }) =>
    reviewers.includes(association) &&
    typeof body === "string" &&
    body.includes(`<!-- ${marker}: ${head} -->`),
);
const labelled = events.some((event) => event.label === label);

// The latest decisive review of each person counts; a comment-only review does not undo an approval.
const latest = new Map();
for (const { user, state, commit } of reviews) {
  if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state))
    latest.set(user, { state, commit });
}
function permissionOf(user) {
  const result = spawnSync(
    "gh",
    ["api", `repos/${repository}/collaborators/${user}/permission`, "--jq", ".permission"],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}
const approvers = [...latest]
  .filter(
    ([user, { state, commit }]) =>
      state === "APPROVED" && commit === head && user !== author,
  )
  .map(([user]) => user)
  .filter((user) => permissions.includes(permissionOf(user)));

if (approvers.length > 0) {
  process.stdout.write(`Approved by ${approvers.join(", ")} for ${head}\n`);
  process.exit(0);
}
if (marked && !labelled) {
  process.stdout.write(
    `Agent review found for ${head} and the label ${label} was never applied, so no person is needed\n`,
  );
  process.exit(0);
}

const reasons = [];
if (!marked)
  reasons.push(`there is no agent review comment for ${head} (marker "<!-- ${marker}: ${head} -->")`);
if (labelled) reasons.push(`the label ${label} was applied to this pull request`);
fail(
  `a person must approve ${head}: ${reasons.join(" and ")}, and no approval of this commit from someone with ${permissions.join(", ")} access was found`,
);
