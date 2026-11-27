#!/usr/bin/env bash
# Installs the Maestro CLI at MAESTRO_VERSION in this job's RUNNER_TEMP and puts it on the job's PATH.
# Maestro's own installer (get.maestro.mobile.dev) writes to ~/.maestro and edits the shell profiles. On a
# persistent runner that home is shared by every job: a job installing one version deleted ~/.maestro/lib under
# another job still running its flows, and two projects on different versions swapped each other's CLI. The
# runner empties RUNNER_TEMP after each job, so nothing here outlives it.
set -euo pipefail

: "${MAESTRO_VERSION:?MAESTRO_VERSION is not set}"
: "${RUNNER_TEMP:?RUNNER_TEMP is not set}"

dir="$RUNNER_TEMP/maestro-cli"
zip="$RUNNER_TEMP/maestro.zip"
url="https://github.com/mobile-dev-inc/maestro/releases/download/cli-$MAESTRO_VERSION/maestro.zip"

if ! curl -fsSL --retry 3 -o "$zip" "$url"; then
  echo "Could not download Maestro $MAESTRO_VERSION from $url. Check the maestro-version input." >&2
  exit 1
fi
rm -rf "$dir"
mkdir -p "$dir"
unzip -q "$zip" -d "$dir"
rm -f "$zip"

if [ ! -x "$dir/maestro/bin/maestro" ]; then
  echo "The Maestro $MAESTRO_VERSION archive has no maestro/bin/maestro." >&2
  exit 1
fi
echo "$dir/maestro/bin" >> "${GITHUB_PATH:?GITHUB_PATH is not set}"
echo "Maestro $MAESTRO_VERSION is in $dir/maestro/bin."
