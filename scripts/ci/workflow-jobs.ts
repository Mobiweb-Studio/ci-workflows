// The text of each job: from its `  name:` line to the next job. This keeps the checks on the file's text, so
// the test needs no YAML parser.
export function jobs(text: string): Record<string, string> {
  const afterJobs = text.slice(text.indexOf("\njobs:\n") + 1);
  const blocks: Record<string, string> = {};
  let current: string | null = null;
  for (const line of afterJobs.split("\n").slice(1)) {
    const header = /^ {2}([a-z][a-z-]*):\s*$/.exec(line);
    if (header) {
      current = header[1];
      blocks[current] = "";
    } else if (current) {
      blocks[current] += `${line}\n`;
    }
  }
  return blocks;
}
