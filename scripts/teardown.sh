#!/usr/bin/env bash
# Tear down the MCP fraud investigation agent sample so it stops costing money.
#
# Deletes the CloudFormation stack and waits for completion. Optionally empties
# and deletes the assets bucket the deploy script created.
#
# Overrides (environment variables):
#   REGION         default us-west-2
#   STACK          default mcp-fraud-investigation
#   BUCKET         default mcp-fraud-sample-assets-<account-id>-<region>
#   DELETE_BUCKET  set to "true" to also empty and delete the assets bucket
set -euo pipefail

REGION="${REGION:-us-west-2}"
STACK="${STACK:-mcp-fraud-investigation}"
DELETE_BUCKET="${DELETE_BUCKET:-false}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-mcp-fraud-sample-assets-${ACCOUNT_ID}-${REGION}}"

echo "==> Deleting CloudFormation stack ${STACK} in ${REGION}"
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
echo "    Waiting for stack deletion to complete (this can take several minutes)."
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK" || true

if [[ "$DELETE_BUCKET" == "true" ]]; then
  if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
    echo "==> Emptying and deleting assets bucket ${BUCKET}"
    aws s3 rm "s3://${BUCKET}" --recursive --region "$REGION" >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 || true
  else
    echo "==> Assets bucket ${BUCKET} not found, skipping."
  fi
else
  echo "==> Leaving assets bucket ${BUCKET} in place (set DELETE_BUCKET=true to remove it)."
fi

echo "==> Teardown complete."
