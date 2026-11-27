// Opens and closes the rehearsal of a release candidate on a scratch project (README, "Cutting a release").
//   node scripts/rehearse.mjs open <owner/repo> <vX.Y.Z-rc.N> [--dispatch <workflow.yml>]...
//   node scripts/rehearse.mjs close <owner/repo> <pr-number>
// `open` clones the project, points every reference its workflows make to this repository at the candidate tag on a
// branch `rehearsal/<tag>`, pushes it and opens a pull request labelled `rehearsal` and titled "do not merge", so the
// project's pull-request checks run against the candidate. `--dispatch` also starts a workflow on that branch by
// hand, for those that never run on a pull request (android-regression.yml, ios-regression.yml, release.yml).
// `close` reads the pull request's checks, refuses while any is still running, comments the result, closes the pull
// request and deletes the branch, and prints the line to keep with the release. It exits 1 when a check failed.
// Needs `gh` signed in with write access to the scratch project. Seven "do not merge" pull requests were opened and
// closed by hand in ICligo's first sprint, and five rehearsals were skipped.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewrite } from "./set-ref.mjs";

const SELF = "Mobiweb-Studio/ci-workflows";
const TAG = /^v\d+\.\d+\.\d+-rc\.\d+$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL = "rehearsal";

const branchFor = (tag) => `rehearsal/${tag}`;

// Rewrites the project's workflow files in `dir`; returns the files it changed.
function pointAt(dir, tag) {
  const workflows = join(dir, ".github", "workflows");
  const changed = [];
  for (const name of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const path = join(workflows, name);
    const before = readFileSync(path, "utf8");
    const after = rewrite(before, tag);
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(name);
    }
  }
  return changed;
}

// `checks` is `gh pr checks --json name,bucket,link`.
function summarize(checks) {
  const by = (bucket) => checks.filter((c) => c.bucket === bucket);
  const failed = [...by("fail"), ...by("cancel")];
  return {
    pending: by("pending").map((c) => c.name),
    failed: failed.map((c) => `${c.name} (${c.link})`),
    passed: by("pass").length,
    skipped: by("skipping").length,
    ok: failed.length === 0 && by("pending").length === 0 && checks.length > 0,
  };
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();

function open(repo, tag, dispatch) {
  try {
    run("gh", ["api", `repos/${SELF}/git/ref/tags/${tag}`, "--jq", ".ref"]);
  } catch {
    throw new Error(`${tag} is not a tag of ${SELF}. Start tag-release with the candidate version first.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "rehearse-"));
  try {
    run("gh", ["repo", "clone", repo, dir, "--", "--depth", "1"]);
    const base = run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchFor(tag);
    run("git", ["-C", dir, "switch", "-c", branch]);
    const changed = pointAt(dir, tag);
    if (changed.length === 0) throw new Error(`No workflow in ${repo} references ${SELF}.`);
    run("git", ["-C", dir, "commit", "-qam", `ci: rehearse ${SELF} ${tag} (do not merge)`]);
    run("git", ["-C", dir, "push", "-q", "-u", "origin", branch]);
    run("gh", ["label", "create", LABEL, "--repo", repo, "--color", "BFD4F2", "--force",
      "--description", `Rehearses a ${SELF} release candidate; never merged`]);
    const body = [
      `Rehearsal of [${SELF} ${tag}](https://github.com/${SELF}/tree/${tag}). **Do not merge.**`,
      "",
      `Every reference to ${SELF} points at \`${tag}\` in: ${changed.map((n) => `\`${n}\``).join(", ")}.`,
      `Closed with \`node scripts/rehearse.mjs close ${repo} <number>\` from ${SELF}.`,
    ].join("\n");
    const url = run("gh", ["pr", "create", "--repo", repo, "--base", base, "--head", branch,
      "--title", `Rehearsal of ${SELF} ${tag} (do not merge)`, "--label", LABEL, "--body", body]);
    for (const workflow of dispatch) {
      run("gh", ["workflow", "run", workflow, "--repo", repo, "--ref", branch]);
      console.log(`Started ${workflow} on ${branch}.`);
    }
    console.log(url);
    console.log(`Watch it: gh pr checks ${url} --watch`);
    console.log(`Then: node scripts/rehearse.mjs close ${repo} ${url.split("/").pop()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function close(repo, number) {
  const pr = JSON.parse(run("gh", ["pr", "view", number, "--repo", repo, "--json", "headRefName,labels,url"]));
  if (!pr.labels.some((l) => l.name === LABEL)) {
    throw new Error(`${pr.url} has no "${LABEL}" label: not a rehearsal, left alone.`);
  }
  let checks;
  try {
    checks = JSON.parse(run("gh", ["pr", "checks", number, "--repo", repo, "--json", "name,bucket,link"]));
  } catch (error) {
    // gh exits non-zero when a check failed or is pending, and still prints the JSON.
    checks = JSON.parse(error.stdout || "[]");
  }
  const result = summarize(checks);
  if (result.pending.length > 0) {
    throw new Error(`Still running: ${result.pending.join(", ")}. Close it when they finish.`);
  }
  const tag = pr.headRefName.replace(/^rehearsal\//, "");
  const line = result.ok
    ? `Rehearsal of ${tag} on ${pr.url}: passed (${result.passed} checks passed, ${result.skipped} skipped).`
    : `Rehearsal of ${tag} on ${pr.url}: failed: ${result.failed.join(", ") || "no checks ran"}.`;
  run("gh", ["pr", "comment", number, "--repo", repo, "--body", line]);
  run("gh", ["pr", "close", number, "--repo", repo, "--delete-branch"]);
  console.log(line);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, repo, arg, ...rest] = process.argv.slice(2);
  const usage =
    "usage: node scripts/rehearse.mjs open <owner/repo> <vX.Y.Z-rc.N> [--dispatch <workflow.yml>]...\n" +
    "       node scripts/rehearse.mjs close <owner/repo> <pr-number>";
  const dispatch = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== "--dispatch" || !/^[\w.-]+\.ya?ml$/.test(rest[i + 1] ?? "")) {
      console.error(usage);
      process.exit(2);
    }
    dispatch.push(rest[i + 1]);
  }
  const valid =
    REPO.test(repo ?? "") &&
    ((command === "open" && TAG.test(arg ?? "")) || (command === "close" && /^\d+$/.test(arg ?? "") && !rest.length));
  if (!valid) {
    console.error(usage);
    process.exit(2);
  }
  try {
    if (command === "open") open(repo, arg, dispatch);
    else close(repo, arg);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
