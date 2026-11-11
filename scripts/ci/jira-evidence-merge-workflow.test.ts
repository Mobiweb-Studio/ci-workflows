import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { jobs } from "./workflow-jobs";

const path = join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "jira-evidence-merge.yml",
);
const workflow = existsSync(path) ? readFileSync(path, "utf8") : "";
const blocks = jobs(workflow);
const job = blocks["jira-evidence"] ?? "";

describe("jira-evidence-merge.yml", () => {
  it("is only called, and refuses an event that gives fork code the secrets", () => {
    const triggers = workflow.slice(
      workflow.indexOf("\non:\n"),
      workflow.indexOf("\njobs:\n"),
    );
    expect(triggers).toContain("  workflow_call:");
    expect(triggers).not.toMatch(/\n {2}(pull_request|push|workflow_dispatch):/);
    expect(workflow).not.toMatch(/^ *pull_request_target:/m);
    expect(workflow).not.toMatch(/^ *workflow_run:/m);
    const guard = job.indexOf('"$EVENT_NAME" != "pull_request"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(job.indexOf("actions/checkout@v4"));
  });

  it("has one job, which runs only for a merged PR from this repository when opted in", () => {
    expect(Object.keys(blocks)).toEqual(["jira-evidence"]);
    expect(job).toContain(
      "if: ${{ github.event.pull_request.merged == true && inputs.jira-evidence && github.event.pull_request.head.repo.full_name == github.repository }}",
    );
  });

  it("reads runs and artifacts, uses the jira-evidence environment and the runner input", () => {
    expect(job).toMatch(
      /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n(?! {6})/m,
    );
    expect(job).toMatch(/^ {4}environment: jira-evidence$/m);
    expect(job).toMatch(/^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/m);
  });

  it("finds the run for the PR's head commit, downloads its artifacts and runs the poster in merge mode", () => {
    const find = job.indexOf("find-evidence-run.mjs");
    const download = job.indexOf("gh run download");
    const post = job.indexOf("jira-evidence.mjs\" merge");
    expect(find).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(find);
    expect(post).toBeGreaterThan(download);
    expect(job).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(job).toContain("BRANCH: ${{ github.head_ref }}");
    expect(job).toContain(
      "RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ steps.find.outputs.run_id }}",
    );
  });

  it("warns, and posts nothing, when no run has artifacts left", () => {
    expect(job).toMatch(
      /if: \$\{\{ steps\.find\.outputs\.run_id == '' \}\}\n[\s\S]*?::warning::/,
    );
    const post = job.slice(job.lastIndexOf("- name:"));
    expect(post).toContain("if: ${{ steps.find.outputs.run_id != '' }}");
  });

  it("takes the evidence target and QA label as optional inputs whose defaults keep the branch's ticket", () => {
    expect(workflow).toMatch(
      /\n {6}jira-evidence-target:\n {8}type: string\n {8}default: branch-ticket\n/,
    );
    expect(workflow).toMatch(
      /\n {6}jira-qa-label:\n {8}type: string\n {8}default: qa\n/,
    );
    const post = job.slice(job.lastIndexOf("- name:"));
    expect(post).toContain(
      "JIRA_EVIDENCE_TARGET: ${{ inputs.jira-evidence-target }}",
    );
    expect(post).toContain("JIRA_QA_LABEL: ${{ inputs.jira-qa-label }}");
    expect(post).not.toContain("continue-on-error");
  });

  it("gives the Jira token and the Microsoft secrets to the poster step alone", () => {
    const post = job.slice(job.lastIndexOf("- name:"));
    const secrets = ["JIRA_API_TOKEN", "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET"];
    expect(job.match(/secrets\./g)).toHaveLength(secrets.length);
    for (const secret of secrets) {
      expect(post).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
  });

  it("takes the evidence storage and the OneDrive library as optional inputs whose default keeps Jira attachments", () => {
    expect(workflow).toMatch(
      /\n {6}jira-evidence-storage:\n {8}type: string\n {8}default: jira\n/,
    );
    for (const input of ["onedrive-drive-id", "onedrive-folder"]) {
      expect(workflow).toMatch(
        new RegExp(`\\n {6}${input}:\\n {8}type: string\\n {8}default: ""\\n`),
      );
    }
    for (const secret of ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET"]) {
      expect(workflow).toMatch(
        new RegExp(`\\n {6}${secret}:\\n {8}required: false\\n`),
      );
    }
    const poster = job.slice(job.lastIndexOf("- name:"));
    for (const line of [
      "JIRA_EVIDENCE_STORAGE: ${{ inputs.jira-evidence-storage }}",
      "MS_DRIVE_ID: ${{ inputs.onedrive-drive-id }}",
      "ONEDRIVE_FOLDER: ${{ inputs.onedrive-folder }}",
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    ]) {
      expect(poster).toContain(line);
    }
  });
});
