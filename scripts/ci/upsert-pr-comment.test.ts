import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(__dirname, "upsert-pr-comment.sh");

// A stand-in for gh: it logs every call, answers a comment listing with canned JSON, and copies the body
// of a create or update call into a file, since the helper deletes its own body file when it ends.
const stubGh = `#!/bin/sh
echo "$@" >> "$CALL_LOG"
if [ -n "$GH_FAIL" ] || { [ -n "$GH_FAIL_ON" ] && case "$*" in *"-X $GH_FAIL_ON"*) true ;; *) false ;; esac; }; then
  echo "gh: simulated failure" >&2
  exit 1
fi
case "$*" in
  *"-X PATCH"* | *"-X POST"*)
    for arg in "$@"; do
      case "$arg" in
        body=@*) cat "\${arg#body=@}" >> "$BODY_LOG" ;;
      esac
    done
    ;;
  *) cat "$COMMENTS_JSON" ;;
esac
`;

describe("upsert-pr-comment", () => {
  let dir: string;
  let counter = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "upsert-pr-comment-"));
    writeFileSync(join(dir, "gh"), stubGh);
    chmodSync(join(dir, "gh"), 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  type Comment = { id: number; body: string; human?: boolean };

  // Runs the helper with a stubbed gh. `pages` is what the comment listing returns, one array per page.
  const run = (
    args: string[],
    pages: Comment[][],
    env: Record<string, string> = {},
  ) => {
    const id = counter++;
    const callLog = join(dir, `calls-${id}.log`);
    const bodyLog = join(dir, `body-${id}.log`);
    const commentsJson = join(dir, `comments-${id}.json`);
    const bodyFile = join(dir, `body-in-${id}.md`);
    writeFileSync(callLog, "");
    writeFileSync(bodyLog, "");
    writeFileSync(
      commentsJson,
      pages
        .map((page) =>
          JSON.stringify(
            page.map(({ human, ...comment }) => ({
              ...comment,
              user: { type: human ? "User" : "Bot" },
            })),
          ),
        )
        .join("\n"),
    );
    writeFileSync(bodyFile, "the new text\n");
    const childEnv: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "acme/app",
      CALL_LOG: callLog,
      BODY_LOG: bodyLog,
      COMMENTS_JSON: commentsJson,
      ...env,
    };
    const result = spawnSync(
      "bash",
      [helper, ...args.map((arg) => (arg === "BODY" ? bodyFile : arg))],
      { env: childEnv as NodeJS.ProcessEnv, encoding: "utf8" },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      calls: readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean),
      body: readFileSync(bodyLog, "utf8"),
    };
  };

  const marker = "<!-- device-check-mode -->";

  it("creates a comment, with the marker on top, when none has the marker", () => {
    const result = run(["device-check-mode", "7", "BODY"], [[]]);
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toContain(
      "-X POST repos/acme/app/issues/7/comments",
    );
    expect(result.body).toBe(`${marker}\nthe new text\n`);
  });

  it("updates the comment that has the marker and creates none", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [[{ id: 11, body: `${marker}\nold text` }]],
    );
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toContain(
      "-X PATCH repos/acme/app/issues/comments/11",
    );
    expect(result.body).toBe(`${marker}\nthe new text\n`);
  });

  it("leaves a comment without the marker alone", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [
        [
          { id: 5, body: "a human comment" },
          { id: 6, body: "<!-- other -->\nreport" },
        ],
      ],
    );
    expect(result.status).toBe(0);
    expect(result.calls[1]).toContain("-X POST");
    expect(result.calls.join("\n")).not.toContain("comments/5");
    expect(result.calls.join("\n")).not.toContain("comments/6");
  });

  it("ignores a comment a person wrote that quotes the marker", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [
        [
          { id: 51, body: `${marker}\nquoted`, human: true },
          { id: 52, body: `${marker}\nthe real one` },
        ],
      ],
    );
    expect(result.status).toBe(0);
    expect(result.calls[1]).toContain("comments/52");
  });

  it("creates a comment when only a person's comment has the marker", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [[{ id: 61, body: `${marker}\nquoted`, human: true }]],
    );
    expect(result.calls[1]).toContain("-X POST");
  });

  it("updates the first comment when two carry the marker", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [
        [
          { id: 21, body: `${marker}\na` },
          { id: 22, body: `${marker}\nb` },
        ],
      ],
    );
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toContain("comments/21");
  });

  it("finds the marker on a later page of comments", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [[{ id: 1, body: "first page" }], [{ id: 2, body: `${marker}\nold` }]],
    );
    expect(result.status).toBe(0);
    expect(result.calls[1]).toContain("comments/2");
  });

  it("touches only its own comment when two markers share a PR", () => {
    const comments = [
      { id: 31, body: "<!-- qa-agent-report -->\nreport" },
      { id: 32, body: `${marker}\nmode` },
    ];
    const mode = run(["device-check-mode", "7", "BODY"], [comments]);
    expect(mode.calls[1]).toContain("comments/32");
    const qa = run(["qa-agent-report", "7", "BODY"], [comments]);
    expect(qa.calls[1]).toContain("comments/31");
  });

  it("with --only-existing creates nothing when no comment has the marker", () => {
    const result = run(
      ["--only-existing", "device-check-mode", "7", "BODY"],
      [[]],
    );
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain("issues/7/comments");
    expect(result.calls[0]).not.toContain("POST");
  });

  it("with --only-existing still updates a comment that has the marker", () => {
    const result = run(
      ["--only-existing", "device-check-mode", "7", "BODY"],
      [[{ id: 41, body: `${marker}\nold` }]],
    );
    expect(result.status).toBe(0);
    expect(result.calls[1]).toContain("-X PATCH");
  });

  it("fails and shows the error when gh fails", () => {
    const result = run(["device-check-mode", "7", "BODY"], [[]], {
      GH_FAIL: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated failure");
  });

  it("fails when the update call fails after a good listing", () => {
    const result = run(
      ["device-check-mode", "7", "BODY"],
      [[{ id: 71, body: `${marker}\nold` }]],
      { GH_FAIL_ON: "PATCH" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated failure");
  });

  it("fails when the create call fails after a good listing", () => {
    const result = run(["device-check-mode", "7", "BODY"], [[]], {
      GH_FAIL_ON: "POST",
    });
    expect(result.status).not.toBe(0);
  });

  it("fails with --only-existing when the listing fails", () => {
    const result = run(
      ["--only-existing", "device-check-mode", "7", "BODY"],
      [[]],
      { GH_FAIL: "1" },
    );
    expect(result.status).not.toBe(0);
  });

  it("fails on missing arguments", () => {
    const result = run(["device-check-mode"], [[]]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage");
  });
});
