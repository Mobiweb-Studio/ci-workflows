import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const files = [
  ...readdirSync(join(root, ".github", "workflows")).map((name) => join(".github", "workflows", name)),
  ...readdirSync(join(root, "actions")).map((name) => join("actions", name, "action.yml")),
].filter((path) => path.endsWith(".yml"));

// Several runners can share one user on a self-hosted Mac. With the default ~/setup-pnpm, two jobs installing pnpm
// at the same time broke each other's install, so each job installs it under its own RUNNER_TEMP.
describe("pnpm/action-setup", () => {
  it.each(files)("%s installs pnpm under the job's RUNNER_TEMP", (path) => {
    const text = readFileSync(join(root, path), "utf8");
    const uses = text.split("uses: pnpm/action-setup@").slice(1);
    for (const rest of uses) {
      const step = rest.slice(0, rest.search(/\n +- /));
      expect(step).toContain("dest: ${{ runner.temp }}/setup-pnpm");
    }
  });
});
