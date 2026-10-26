# ci-workflows

Reusable GitHub Actions workflows and actions for Mobiweb Expo projects. A project keeps thin caller files in its own `.github/workflows/` and calls the shared workflows here:

```yaml
jobs:
  ci:
    uses: Mobiweb-Studio/ci-workflows/.github/workflows/ci.yml@v1
```

The repository is public so that projects in other GitHub organisations can call it. It holds CI logic only: no app code, no docs and no secrets. Secrets and environments stay in each project.

## Using it

1. Copy the caller files from [`examples/callers/`](examples/callers) into the project's `.github/workflows/`. Keep each file's job id: a called job reports as `<caller job> / <shared job>`, so `ci` reports `ci / checks`, `ci / commits`, `ci / secret-scan` and `ci / ticket-key`, and the device gate waits for those names. Add the names you want to require to the main branch's ruleset.
2. Set the inputs. Every input and the token permissions the caller must grant are listed in the header comment of the workflow, and the caller examples already set them. A caller sets only inputs and secrets. It also owns its triggers, path filters, concurrency groups and token permissions. To change what a workflow does, add your own jobs in a separate workflow file; do not edit the steps of a shared one.
3. Give each caller job the permissions its example grants. A called workflow can only narrow the caller's token, so a caller that grants less fails at startup.
4. Create the environments the workflows declare, in the project: `qa-agent` (`CLAUDE_CODE_OAUTH_TOKEN`), `jira-evidence` (`JIRA_API_TOKEN`) and `production-release` (`EXPO_TOKEN`, optionally `SENTRY_AUTH_TOKEN`). A shared job that declares an environment reads that environment's secrets from the calling repository. The one repository secret, `RELEASE_PLEASE_TOKEN`, is passed by name. `secrets: inherit` is not used, because it only works inside one organisation.

## The workflows

| Workflow | Caller job id | What it does |
|---|---|---|
| `ci.yml` | `ci` | Commit messages, secret scan, types, lint, tests, layout, dead code, and the Jira ticket key when asked. |
| `docs-check.yml` | `docs-check` | Requires docs for feature changes unless the PR has `no-docs`. |
| `device-check-mode.yml` | `device-check-mode` | Keeps one PR comment that says whether the two device checks run and why. |
| `device-checks.yml` | `device-checks` | Maestro and the QA agent on one shared APK, then the Jira evidence. |
| `native-cache.yml` | `native-cache` | Seeds the APK and build caches on main. |
| `jira-evidence-merge.yml` | `jira-evidence-merge` | Attaches the last device-check screenshots to the Jira ticket when the PR merges. |
| `release.yml` | `release` | release-please, then the store build and submit when a release PR merges. |
| `hotfix-ota.yml` | `hotfix` | A JS-only production update, started by hand. |

`device-checks` also takes `maestro` and `qa-agent`, both true by default, so a project that declined a device check passes false and that check never runs. Every workflow takes a `runner` input that defaults to the Blacksmith label the boilerplate uses. A project without Blacksmith passes its own label; the emulator jobs need KVM and a large disk.

### What a project provides

The workflows read these from the project's checkout, at fixed paths: `.nvmrc`, `package.json` scripts (`typecheck`, `lint`, `test`, `fsd`, `dead-code`, `vendor-isolation`), `pnpm-lock.yaml`, `app.config.ts`, `eas.json`, `release-please-config.json` and `.release-please-manifest.json`, `vendors/<vendor>/vendor.json` and its `qa-notes.md` and `maestro/` folder, `.maestro/flows/`, and `scripts/agent-qa/instructions.md` (the QA agent's prompt). The shared scripts under `scripts/ci/` and `scripts/agent-qa/` are bundled with the actions and found through the `ci-scripts` action; a project does not carry them.

### Token safety

`device-checks`, `device-check-mode` and `jira-evidence-merge` hold the Claude and Jira tokens, so they fail their first job on any event but `pull_request`. Never trigger their callers from `pull_request_target` or `workflow_run`. The `release` and `hotfix-ota` callers hold store credentials: pin them to an exact tag (`@v1.2.3`) when the project wants a person to review each change to them, and require reviewers on `production-release`. A caller pinned to an exact tag pulls actions that match that tag.

## Versioning

Releases are exact tags (`v1.2.3`). `v1` is a floating major that moves to each compatible release, so a project gets CI fixes with no change. A breaking change ships as `v2`, and a project upgrades by changing its refs. A change is breaking when it adds a required input, removes or renames an input, changes a secret or an environment name, changes a check name, or changes a project-owned file the workflows read (see "What a project provides").

A release commit rewrites the internal references between workflows and actions to its own tag (`node scripts/set-ref.mjs <ref>`); on `main` they name `main`.

### Cutting a release

1. Start `tag-release` from `main` with the version `1.2.3-rc.1`. It tests, rewrites the references, and tags `v1.2.3-rc.1`. Nothing else moves.
2. Rehearse the candidate on a scratch project: point its callers at `@v1.2.3-rc.1`, set every documented input, and run its CI. A release that adds a required input is a new major.
3. When the rehearsal passes, start `tag-release` with `1.2.3` and `rehearsal-passed` set. It tags `v1.2.3` and moves `v1` to it.
4. To roll back, move `v1` back to the previous exact tag.

## Maintaining this repository

The owner sets these in the repository settings: a ruleset on `main` (pull request, code-owner review, no force-push, no bypass), a tag ruleset limiting `v*` tags to the maintainers team and the GitHub Actions app that runs `tag-release`, read-only default workflow permissions, approval required for every outside-collaborator workflow run, two-factor for members with write access, and a `release` environment with required reviewers and the secret `RELEASE_PUSH_TOKEN`, a fine-grained token (or GitHub App token) for this repository with contents write and workflows write. The release commit changes workflow files, which the built-in token cannot push. The repository's own workflows run on `pull_request` with a read-only token and GitHub-hosted runners, and `tag-release` is started by hand from `main` only.

`pnpm test` runs the script tests and the workflow-shape tests, `pnpm typecheck` checks them, and `pnpm lint:workflows` runs actionlint through Docker.

A project in another organisation must allow `Mobiweb-Studio/ci-workflows` and the third-party actions it uses in its Actions settings when it restricts which actions may run.
