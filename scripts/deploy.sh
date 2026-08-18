#!/usr/bin/env bash
# Deploy the MCP fraud investigation agent sample.
# Sandbox account only. us-west-2 only (the template enforces the region).
#
# What it does:
#   1. Creates (or reuses) an S3 bucket in us-west-2 for the seed bundle.
#   2. Uploads assets/seed-bundle.zip to that bucket.
#   3. Deploys cloudformation/mcp-fraud-lab.yaml, pointing the stack at the bundle.
#   4. Prints the dashboard URL, login email, and password-secret name.
#
# Overrides (environment variables):
#   REGION   default us-west-2 (do not change; the template only allows us-west-2)
#   BUCKET   default mcp-fraud-sample-assets-<account-id>-<region>
#   STACK    default mcp-fraud-investigation
set -euo pipefail

REGION="${REGION:-us-west-2}"
STACK="${STACK:-mcp-fraud-investigation}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${REPO_ROOT}/cloudformation/mcp-fraud-lab.yaml"
BUNDLE="${REPO_ROOT}/assets/seed-bundle.zip"
OBJECT_KEY="seed-bundle.zip"

if [[ "$REGION" != "us-west-2" ]]; then
  echo "ERROR: this sample only deploys in us-west-2 (the template rejects other regions)." >&2
  exit 1
fi

if [[ ! -f "$BUNDLE" ]]; then
  echo "ERROR: ${BUNDLE} not found. Run scripts/build-bundle.sh first, or restore the prebuilt bundle." >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-mcp-fraud-sample-assets-${ACCOUNT_ID}-${REGION}}"

echo "==> Account ${ACCOUNT_ID} | Region ${REGION} | Stack ${STACK}"
echo "==> Assets bucket ${BUCKET}"

echo "==> Ensuring the assets bucket exists"
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "    Bucket already exists, reusing it."
else
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
  echo "    Created ${BUCKET} (public access fully blocked)."
fi

echo "==> Uploading seed bundle to s3://${BUCKET}/${OBJECT_KEY}"
aws s3 cp "$BUNDLE" "s3://${BUCKET}/${OBJECT_KEY}" --region "$REGION"

echo "==> Deploying CloudFormation stack ${STACK} (this takes about 15 to 20 minutes)"
# The template exceeds the 51,200-byte inline limit, so it is staged in the
# assets bucket (--s3-bucket) before deployment.
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  --s3-bucket "$BUCKET" \
  --s3-prefix cfn-template \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    AssetsBucketName="$BUCKET" \
    AssetsObjectKey="$OBJECT_KEY"

echo ""
echo "==> Stack outputs"
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue,Description:Description}" \
  --output table

DASHBOARD_URL="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='FraudDashboardURL'].OutputValue" --output text)"
LOGIN_EMAIL="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WorkshopUsername'].OutputValue" --output text)"
PASSWORD_SECRET="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WorkshopPasswordSecret'].OutputValue" --output text)"

echo ""
echo "==> Done."
echo "    Dashboard : ${DASHBOARD_URL}"
echo "    Login     : ${LOGIN_EMAIL}"
echo "    Password  : read it with"
echo "                aws secretsmanager get-secret-value --secret-id ${PASSWORD_SECRET} --region ${REGION} --query SecretString --output text"
