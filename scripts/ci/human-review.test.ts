import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "human-review.mjs");

const HEAD = "abc1234";
const OLD = "0000000";

type Comment = { body: string; association: string };
type Review = { user: string; state: string; commit: string };

// A stand-in for gh. It answers by the endpoint in the arguments: comments, events and reviews from files holding
// one JSON object per line (what `gh api --paginate --jq` prints), and a person's permission from a file named after
// the user. A file holding FAIL makes the call fail.
const stubGh = `#!/bin/sh
case "$*" in
  *"/issues/7/comments"*) file="$FIXTURES/comments" ;;
  *"/issues/7/events"*) file="$FIXTURES/events" ;;
  *"/pulls/7/reviews"*) file="$FIXTURES/reviews" ;;
  *"/collaborators/"*) user=$(echo "$*" | sed 's|.*collaborators/\\([^/]*\\)/permission.*|\\1|'); file="$FIXTURES/permission-$user" ;;
  *) echo "gh: unexpected call: $*" >&2; exit 2 ;;
esac
if [ ! -f "$file" ] || grep -q FAIL "$file"; then
  echo "gh: simulated failure" >&2
  exit 1
fi
cat "$file"
`;

const agentReview = (sha: string, association = "MEMBER"): Comment => ({
  body: `Review summary\n<!-- ce-code-review: ${sha} -->`,
  association,
});
const labelled = [{ label: "needs-human-review" }];
const approval = (user: string, commit = HEAD): Review => ({
  user,
  state: "APPROVED",
  commit,
});

describe("human-review", () => {
  let dir: string;
  let fixtures: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "human-review-"));
    fixtures = join(dir, "fixtures");
    mkdirSync(fixtures);
    writeFileSync(join(dir, "gh"), stubGh);
    chmodSync(join(dir, "gh"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = (values: unknown[]) => values.map((v) => JSON.stringify(v)).join("\n");
  const run = (
    pr: {
      comments?: Comment[];
      events?: unknown[];
      reviews?: Review[];
      permissions?: Record<string, string>;
      author?: string;
    },
    env: Record<string, string> = {},
  ) => {
    writeFileSync(join(fixtures, "comments"), lines(pr.comments ?? []));
    writeFileSync(join(fixtures, "events"), lines(pr.events ?? []));
    writeFileSync(join(fixtures, "reviews"), lines(pr.reviews ?? []));
    for (const [user, permission] of Object.entries(pr.permissions ?? {})) {
      writeFileSync(join(fixtures, `permission-${user}`), permission);
    }
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FIXTURES: fixtures,
        REPOSITORY: "acme/app",
        PR_NUMBER: "7",
        HEAD_SHA: HEAD,
        PR_AUTHOR: "dev",
        ...env,
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };

  it("Covers AE2: passes a pull request with an agent review of its head commit and no label", () => {
    const result = run({ comments: [agentReview(HEAD)] });

    expect(result.status).toBe(0);
    expect(result.output).toContain("no person is needed");
  });

  it("fails with no agent review comment for the head commit until a maintainer approves", () => {
    expect(run({}).status).toBe(1);
    // A review of an earlier commit does not count after a push.
    const stale = run({ comments: [agentReview(OLD)] });
    expect(stale.status).toBe(1);
    expect(stale.output).toContain("no agent review comment");

    const approved = run({
      comments: [agentReview(OLD)],
      reviews: [approval("lead")],
      permissions: { lead: "maintain" },
    });
    expect(approved.status).toBe(0);
    expect(approved.output).toContain("Approved by lead");
  });

  it("does not count an agent review comment from someone who is not a collaborator", () => {
    const result = run({ comments: [agentReview(HEAD, "NONE")] });

    expect(result.status).toBe(1);
  });

  it("fails while the label was ever applied, even if it was removed, until a maintainer approves", () => {
    const withLabel = run({
      comments: [agentReview(HEAD)],
      events: labelled,
    });
    expect(withLabel.status).toBe(1);
    expect(withLabel.output).toContain("needs-human-review was applied");

    const approved = run({
      comments: [agentReview(HEAD)],
      events: labelled,
      reviews: [approval("lead")],
      permissions: { lead: "admin" },
    });
    expect(approved.status).toBe(0);
  });

  it("ignores an approval of an earlier commit, the author's own approval, and one from a reader", () => {
    const base = { comments: [], events: labelled };

    expect(
      run({ ...base, reviews: [approval("lead", OLD)], permissions: { lead: "write" } }).status,
    ).toBe(1);
    expect(
      run({ ...base, reviews: [approval("dev")], permissions: { dev: "admin" } }).status,
    ).toBe(1);
    expect(
      run({ ...base, reviews: [approval("guest")], permissions: { guest: "read" } }).status,
    ).toBe(1);
  });

  it("lets a later request for changes undo an approval, and a comment-only review leave it", () => {
    const permissions = { lead: "write" };
    const undone = run({
      events: labelled,
      reviews: [
        approval("lead"),
        { user: "lead", state: "CHANGES_REQUESTED", commit: HEAD },
      ],
      permissions,
    });
    expect(undone.status).toBe(1);

    const kept = run({
      events: labelled,
      reviews: [approval("lead"), { user: "lead", state: "COMMENTED", commit: HEAD }],
      permissions,
    });
    expect(kept.status).toBe(0);
  });

  it("takes the label, the marker and the permissions from the inputs", () => {
    const result = run(
      {
        comments: [
          { body: `<!-- agent-review: ${HEAD} -->`, association: "OWNER" },
        ],
        events: [{ label: "needs-human-review" }],
      },
      { LABEL: "risky", MARKER: "agent-review" },
    );
    expect(result.status).toBe(0);

    const strict = run(
      { events: labelled, reviews: [approval("dev2")], permissions: { dev2: "write" } },
      { APPROVER_PERMISSIONS: "admin,maintain" },
    );
    expect(strict.status).toBe(1);
  });

  it("fails, and never passes, when the API cannot be read", () => {
    writeFileSync(join(fixtures, "comments"), "FAIL");
    writeFileSync(join(fixtures, "events"), "");
    writeFileSync(join(fixtures, "reviews"), "");
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FIXTURES: fixtures,
        REPOSITORY: "acme/app",
        PR_NUMBER: "7",
        HEAD_SHA: HEAD,
        PR_AUTHOR: "dev",
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be read");
  });

  it("requires its inputs", () => {
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REPOSITORY is required");
  });
});
