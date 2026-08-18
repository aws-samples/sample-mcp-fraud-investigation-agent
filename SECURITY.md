# Security Policy

## Intended use

This repository is a demonstration sample. It stands up a working AI fraud
investigation system so you can learn how Model Context Protocol (MCP) and
Amazon Bedrock AgentCore fit together. Deploy it only in a disposable sandbox
AWS account in us-west-2, and tear it down when you are finished. Do not deploy
it to a production account, a shared account, or any environment that holds real
data.

All data in this sample is synthetic. The transactions, customer profiles,
login activity, and support cases under `assets/seed-data/` are fabricated for
the demo and do not represent real people.

## Design choices made for a self-contained sample

This sample is optimized to deploy cleanly into a single sandbox account and to
tear down completely. A few configurations are deliberate and are documented
here so they are not mistaken for oversights:

- Resources are encrypted with a customer-managed KMS key created by the stack
  (DynamoDB tables, the ECR repository, and the CodeBuild project). The stack
  also uses S3 public access blocks, S3 versioning, DynamoDB point-in-time
  recovery, and API Gateway tracing.
- The generated dashboard password is stored in AWS Secrets Manager using the
  AWS-managed key rather than a customer-managed key, so that a workshop
  attendee can read their own generated password with the CLI without being
  granted extra KMS permissions.
- The custom-resource Lambda functions run once at deploy time and are not
  placed in a VPC, do not use dead-letter queues, and do not reserve
  concurrency. Reserving concurrency in particular is avoided because sandbox
  accounts often cannot spare it against the account concurrency floor.
- S3 access logging, S3 Object Lock, and Secrets Manager rotation are not
  enabled, since the buckets and secret are created and destroyed within the
  lifetime of a short-lived demo.

Anyone adapting this sample for use beyond a throwaway sandbox should revisit
these choices, tighten IAM to least privilege for their environment, and re-run
their own security review.

## Reporting a security issue

If you discover a potential security issue in this sample, do not open a public
issue or pull request. Instead, report it to AWS/Amazon Security via the
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or email aws-security@amazon.com.
