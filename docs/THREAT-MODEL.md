# Threat Model: MCP Fraud Investigation Agent (Sample)

Simplified AWS SA threat model for the aws-samples sample
`sample-mcp-fraud-investigation-agent`. This is an educational, sandbox-only
sample. It is not production code.

## Assumptions

- A-01: Deployed only in a disposable sandbox AWS account that the deployer owns, in us-west-2 only (enforced by a CloudFormation stack rule).
- A-02: All data is synthetic seed data. No customer data, customer metadata, AWS business data, or real secrets are present.
- A-03: The deployer is the account owner or an administrator with access to the account's KMS key and Secrets Manager.
- A-04: The sample is torn down after use. Resources are short-lived.
- A-05: The sample is not deployed to production without additional security review and testing, as stated in the README and SECURITY.md.

## Architecture and trust boundaries

A React dashboard on AWS Amplify calls an Amazon Bedrock AgentCore Runtime, which
runs a Strands SDK agent that reaches data over MCP through an AgentCore Gateway.
There is no Lambda in the runtime request path.

1. Internet to Amplify dashboard: HTTPS, static single-page app.
2. Dashboard to Amazon Cognito: user authentication, JWT issued.
3. Dashboard to AgentCore Runtime: authenticated server-sent-events stream, JWT validated.
4. Agent to AgentCore Gateway: MCP over OAuth2 client_credentials (Cognito machine client, scoped resource server).
5. Gateway to two API Gateway REST APIs: AuthorizationType AWS_IAM, direct DynamoDB and S3 integrations via scoped IAM roles.
6. Gateway to Amazon Bedrock Managed Knowledge Base: Retrieve only.
7. CloudFormation custom-resource Lambdas to AWS APIs: deploy time only, not in the request path.

## STRIDE

| Threat | Mitigation in the sample |
|--------|--------------------------|
| Spoofing | Cognito JWT for users; OAuth2 client_credentials with a scoped gateway scope for the agent; API Gateway methods use AWS_IAM. |
| Tampering | TLS in transit (DenyInsecureTransport bucket policies on all five buckets, HTTPS APIs); customer-managed KMS key on DynamoDB, ECR, CodeBuild, and the custom-resource DLQ, with rotation on; S3 SSE plus Block Public Access plus BucketOwnerEnforced; versioning enabled. |
| Repudiation | X-Ray tracing on both API Gateway stages; CloudTrail in the deployer account; S3 server access logging on all data buckets to a dedicated log bucket. |
| Information disclosure | No public S3 (Block Public Access on every bucket, ACLs disabled); least-privilege IAM per component; password stored in Secrets Manager; JWT-gated agent stream; KMS and SSE at rest. |
| Denial of service | Sandbox-only sample; Amazon Bedrock and service quotas apply; custom-resource Lambdas have a dead letter queue. |
| Elevation of privilege | Scoped IAM roles per component with resource-scoped actions and no wildcard actions; deploy-time roles isolated from the runtime path. |

## Residual risk

Low and accepted. The residual scan findings are infrastructure best-practice
controls that are either not applicable to an ephemeral sandbox sample or are
deliberate design tradeoffs, and are enumerated in
[SECURITY-REVIEW.md](SECURITY-REVIEW.md). The most relevant real-world
risk is accidental deployment to production, which is mitigated by the region
lock, the production disclaimers in the README and SECURITY.md, and the MIT-0
license disclaimer. There are no exploitable critical or high vulnerabilities.
