# Security Review and Findings Disposition

Findings disposition for the security review of
`sample-mcp-fraud-investigation-agent`. This is an educational, sandbox-only
sample. It is not production code.

## Scan coverage

| Content type | Scanner | Result |
|--------------|---------|--------|
| CloudFormation template | Holmes (cfn-guard, checkov, ACAT) | 62 findings driven to 4, all accepted best-practice items |
| Python (agent) | Holmes (bandit) | No findings |
| JavaScript (dashboard) | Holmes (semgrep) | No findings |
| Lab notebook | Holmes (CodeGuru) | 1 low informational finding, accepted |
| Third-party libraries (dashboard) | npm_audit | 43 findings, all in the build toolchain (dev and build time only) |
| Containers | Trivy | Not applicable, no prebuilt image is shipped |

## Residual findings (5)

The full-repository Holmes scan surfaces five findings: four on the
CloudFormation template and one informational item in the lab notebook. All are
documented, accepted items with no exploitable critical or high issue. The
template started at 62 findings and was hardened across successive scan passes:
S3 access logging on all data buckets, ownership controls with ACLs disabled, a
shared KMS-encrypted dead letter queue on all seven custom-resource Lambdas,
scoped IAM actions with no wildcards, and TLS-only bucket policies.

| # | Finding | Count | Disposition |
|---|---------|-------|-------------|
| 1 | CKV_AWS_18 (S3 access logging) | 1 | The dedicated S3 access-log bucket cannot log to itself without creating a recursive logging loop. All other buckets log to it. Accepted by design. |
| 2 | CKV_AWS_149 (secret uses AWS-managed key) | 1 | The workshop password secret uses the AWS-managed key on purpose so the deployer can read it with the AWS CLI in a sandbox. No customer or production data is stored. Accepted for an educational sample. |
| 3 | CKV_AWS_76 (API Gateway access logging) | 2 | Enabling API Gateway access logging requires an account-region-global AWS::ApiGateway::Account CloudWatch role. A distributable sample must not mutate that account-wide singleton because it would overwrite a value shared by every API in the account. X-Ray tracing is enabled on both stages as a compensating control. Accepted by design. |
| 4 | guru/External3PDownload (lab notebook) | 1 | Low, informational. The optional lab notebook installs the uv tool from the official Astral installer (`curl https://astral.sh/uv/install.sh`). The notebook is run manually by the learner in a sandbox and is not part of any deployed runtime path. Accepted for an educational sample. |

Scanner behavior note: the Holmes scanner honors cfn-guard
`Metadata.guard.SuppressedRules` (justified findings are recorded as suppressed
with a reason and do not surface). It does not honor inline `checkov:skip`
comments, so a small number of checkov findings surface even where a reason is
documented. The items above are the residual set after suppression.

## Third-party library findings (npm_audit)

npm_audit reports 43 findings (2 critical, 21 high, remainder moderate and low).
All 43 are transitive dependencies of `react-scripts` (Create React App), which
is the dashboard build toolchain. These run at development and build time only.

- Runtime dependencies are clean: `react`, `react-dom`, `react-markdown`, and `@cloudscape-design/*` report zero findings.
- The sample ships a prebuilt static dashboard bundle, so a customer never installs or runs the build toolchain to use it.
- `npm audit fix --force` was rejected because it downgrades react-scripts and breaks the Create React App build. A Vite migration was out of scope for this sample.

Disposition: accepted. Build-time-only toolchain findings with a shipped
prebuilt bundle, no runtime exposure.

## Production disclaimer

The README and SECURITY.md state that this sample is educational, sandbox-only,
us-west-2 only, and not for production without additional security review and
testing. It is licensed MIT-0 with a THIRD-PARTY-LICENSES attribution file.
