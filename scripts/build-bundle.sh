#!/usr/bin/env bash
# Rebuild assets/seed-bundle.zip from source.
#
# The stack self-loads this bundle on deploy: seed data becomes DynamoDB
# records, S3 support cases, and the knowledge-base playbooks, and the built
# dashboard is published to Amplify.
#
# Steps:
#   1. Build the React dashboard in assets/dashboard/ (npm ci + npm run build).
#   2. Zip the build output into dashboard/build.zip (index.html at the root).
#   3. Assemble seed-data/, dashboard/build.zip, and the notebook into
#      assets/seed-bundle.zip.
#
# Requires Node.js 18+ and npm. You only need this if you changed the dashboard,
# the seed data, or the notebook; the repo already ships a prebuilt bundle.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH_DIR="${REPO_ROOT}/assets/dashboard"
SEED_DIR="${REPO_ROOT}/assets/seed-data"
NOTEBOOK="${REPO_ROOT}/assets/agent/fraud-agent-lab.ipynb"
OUT_BUNDLE="${REPO_ROOT}/assets/seed-bundle.zip"

for tool in npm zip rsync; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' is required but not installed." >&2; exit 1; }
done
[[ -d "$DASH_DIR" ]]  || { echo "ERROR: ${DASH_DIR} not found." >&2; exit 1; }
[[ -d "$SEED_DIR" ]]  || { echo "ERROR: ${SEED_DIR} not found." >&2; exit 1; }
[[ -f "$NOTEBOOK" ]]  || { echo "ERROR: ${NOTEBOOK} not found." >&2; exit 1; }

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> Building the dashboard (npm ci + npm run build)"
( cd "$DASH_DIR" && npm ci && npm run build )

echo "==> Packaging dashboard build into dashboard/build.zip"
mkdir -p "${STAGING}/dashboard"
( cd "${DASH_DIR}/build" && zip -qr "${STAGING}/dashboard/build.zip" . )

echo "==> Staging seed data (excluding README.md)"
mkdir -p "${STAGING}/seed-data"
rsync -a --exclude 'README.md' "${SEED_DIR}/" "${STAGING}/seed-data/"

echo "==> Adding the notebook"
cp "$NOTEBOOK" "${STAGING}/fraud-agent-lab.ipynb"

echo "==> Writing ${OUT_BUNDLE}"
rm -f "$OUT_BUNDLE"
( cd "$STAGING" && zip -qr "$OUT_BUNDLE" seed-data dashboard fraud-agent-lab.ipynb )

echo "==> Done. Bundle contents:"
unzip -l "$OUT_BUNDLE"
