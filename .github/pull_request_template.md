## What and why

<!-- What changes for a project that calls these workflows, and the case that showed it was needed (a project PR, run or ADR). -->

## Shared, not one client's

- [ ] Another project could use this unchanged. Anything only one client needs (a name, a key, a path, a service) is behind an input whose default keeps today's behaviour, or stays in that project's own workflows.

## Callers

- [ ] No input, secret, environment or check name is added as required, removed or renamed (otherwise this is a new major, README "Versioning").
- [ ] Changed defaults, if any, are listed below with the old value a caller passes to keep it.
- [ ] A change to `release`, `hotfix-ota` or a job that pushes, publishes or syncs links a dry run from a scratch project (README "Maintaining this repository").
- [ ] A shell change was tested on a Mac (`/bin/bash` 3.2), or the change has none.

### Changed defaults

<!-- | Workflow | Input | Old | New | -->
None.
