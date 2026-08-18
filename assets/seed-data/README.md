# Seed Data for MCP Fraud Investigation Workshop

This directory contains all seed data that gets loaded into AWS resources during stack deployment.

## Structure

```
seed-data/
├── transactions/          → DynamoDB Import (fraud-transactions table)
│   └── data.json          DYNAMODB_JSON format, one item per line
├── customer-profiles/     → DynamoDB Import (fraud-customer-profiles table)
│   └── data.json          DYNAMODB_JSON format, one item per line
├── login-activity/        → DynamoDB Import (fraud-login-activity table)
│   └── data.json          DYNAMODB_JSON format, one item per line
├── support-cases/         → S3 (fraud-support-cases bucket)
│   └── cases/
│       ├── CUST-2847.json
│       └── CUST-7788.json
└── playbooks/             → S3 (fraud-fraud-playbooks bucket) → Bedrock KB
    ├── account-takeover-response.txt
    ├── transaction-velocity-rules.txt
    └── fraud-classification-guide.txt
```

## DynamoDB Import

Tables use `ImportSourceSpecification` in CloudFormation to load data directly from S3 at creation time — no Lambda required.

Format: DYNAMODB_JSON (one JSON object per line with DynamoDB type descriptors)

## S3 Data

Support cases and playbooks are uploaded to S3 as part of the workshop package deployment. The playbooks bucket feeds the Bedrock Knowledge Base.

## Pre-deployment

Before deploying the CFN stack, upload this seed-data directory to the staging S3 bucket:
```bash
aws s3 sync ./seed-data s3://<staging-bucket>/seed-data/
```
