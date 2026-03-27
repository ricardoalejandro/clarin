#!/bin/bash
# version.sh — Generates BUILD_VERSION from CHANGELOG.md
# Format: YYYY.MM.DD-N where N is the build number for that day
#
# Usage:
#   ./version.sh          → prints version string (e.g. 2026.03.27-1)
#   source version.sh     → sets BUILD_VERSION env var

set -euo pipefail

CHANGELOG="$(dirname "$0")/CHANGELOG.md"
TODAY=$(date +%Y.%m.%d)
TODAY_DASH=$(date +%Y-%m-%d)

# Count builds for today by looking at "### Build N" lines under today's date section
BUILD_NUM=0
if [ -f "$CHANGELOG" ]; then
  IN_TODAY=false
  while IFS= read -r line; do
    if [[ "$line" == "## $TODAY_DASH" ]]; then
      IN_TODAY=true
      continue
    fi
    if [[ "$line" == "## "* ]] && $IN_TODAY; then
      break
    fi
    if $IN_TODAY && [[ "$line" =~ ^"### Build "([0-9]+) ]]; then
      N="${BASH_REMATCH[1]}"
      if (( N > BUILD_NUM )); then
        BUILD_NUM=$N
      fi
    fi
  done < "$CHANGELOG"
fi

if (( BUILD_NUM == 0 )); then
  BUILD_NUM=1
fi

export BUILD_VERSION="${TODAY}-${BUILD_NUM}"
echo "$BUILD_VERSION"
