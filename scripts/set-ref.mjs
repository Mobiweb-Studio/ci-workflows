// Points every reference from one shared workflow or action to another at a ref.
//   node scripts/set-ref.mjs <ref> [<root>]
// On main the references name `main`, so the repository's own checks exercise the code under review. A release
// rewrites them to the release's exact tag (the shared workflows reach the actions and each other by reference;
// the repository's own self-test and tag-release workflows reference nothing) (v1.2.3, v1.2.3-rc.1), so a caller pinned to that tag, or to the
// floating major that moves to it, pulls actions that match the workflow. The caller examples are left alone:
// they name the major, which a maintainer changes by hand when cutting a new major.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE =
  /(Mobiweb-Studio\/ci-workflows\/(?:actions\/[a-z-]+|\.github\/workflows\/[a-z-]+\.yml))@[^\s"']+/g;

export function rewrite(text, ref) {
  return text.replace(REFERENCE, `$1@${ref}`);
}

function files(root) {
  const found = [];
  const workflows = join(root, ".github", "workflows");
  for (const name of readdirSync(workflows)) {
    if (name.endsWith(".yml")) found.push(join(workflows, name));
  }
  const actions = join(root, "actions");
  for (const name of readdirSync(actions)) {
    found.push(join(actions, name, "action.yml"));
  }
  return found;
}

export function setRef(root, ref) {
  const changed = [];
  for (const path of files(root)) {
    const before = readFileSync(path, "utf8");
    const after = rewrite(before, ref);
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(path);
    }
  }
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [ref, root = process.cwd()] = process.argv.slice(2);
  if (!ref || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    console.error("usage: node scripts/set-ref.mjs <ref> [<root>]");
    process.exit(1);
  }
  for (const path of setRef(root, ref)) console.log(path);
}
