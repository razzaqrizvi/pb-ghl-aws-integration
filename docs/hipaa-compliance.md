# HIPAA Compliance

> **Disclaimer:** This document describes the technical controls implemented in this integration. It is not legal advice. The client is responsible for their own HIPAA compliance programme, BAAs, workforce training, and organisational safeguards.

---

## Core Principle: AWS as HIPAA-Compliant Bridge

GoHighLevel (GHL) **does not sign a Business Associate Agreement (BAA)** and is not a HIPAA-covered platform. The client's patient data lives in Practice Better (PB), which is HIPAA-compliant.

The solution: **AWS acts as a controlled intermediary.** The client's AWS account is enrolled in the AWS BAA. All data processing and storage happens inside AWS. Only a carefully filtered, non-PHI subset of data ever reaches GHL.

```
Practice Better (HIPAA) ──▶ AWS Bridge (HIPAA, BAA) ──▶ GoHighLevel (non-PHI only)
```

---

## What Is Sent to GoHighLevel

GHL only ever receives data that is **not PHI**:

| Data Sent to GHL | PHI? | Notes |
|---|---|---|
| First name | No | General identifier |
| Last name | No | General identifier |
| Email address | No | Used for CRM deduplication |
| Phone number | No | CRM contact field |
| Membership plan name | No | Non-clinical category |
| Membership status | No | active / cancelled / paused |
| Tags (e.g. "active-member") | No | Non-clinical labels |

**Nothing clinical is ever forwarded.** Session notes, diagnoses, treatment plans, health goals, medications, and any other clinical data remain in Practice Better only.

---

## Technical Safeguards

### 1. Encryption at Rest

| Resource | Encryption |
|---|---|
| DynamoDB table | AWS KMS Customer Managed Key (CMK) |
| SSM Parameter Store secrets | AWS KMS (SecureString type) |
| CloudWatch Logs | AWS-managed encryption |

### 2. Encryption in Transit

- All Lambda → PB API calls use HTTPS (TLS 1.2+)
- All Lambda → GHL API calls use HTTPS (TLS 1.2+)
- API Gateway enforces HTTPS only — HTTP disabled
- AWS internal service communication uses AWS-managed TLS

### 3. Secrets Management

No credentials, API keys, or identifiers exist in:
- Source code (this repository)
- Lambda environment variables (only the **secret name** is in env vars, never the secret value)
- CloudFormation template parameter values
- GitHub Actions (only AWS deploy role ARN, via OIDC)

All secrets stored in **AWS Secrets Manager** as a single JSON secret. Retrieved by Lambdas at cold start, cached in-memory for the function lifetime.

**Pattern used across all Lambdas:**
```javascript
// Environment variable holds the secret NAME only — not the value
const res = await secretsClient.send(
  new GetSecretValueCommand({ SecretId: process.env.PB_SECRET_NAME })
);
const secrets = JSON.parse(res.SecretString);
// secrets.GHL_API_KEY, secrets.client_id etc. used in memory only
```

**Lambda environment variables (safe to be visible):**
- `SYNC_TABLE_NAME` — DynamoDB table name
- `PB_SECRET_NAME` — Secrets Manager secret name (not the secret value)

**What lives in Secrets Manager (never in code or env vars):**
- PB OAuth `client_id` and `client_secret`
- PB `token_url`
- GHL API key
- GHL Location ID
- GHL Custom Field IDs and keys
- PB tag IDs for membership labels

### 4. IAM — Least Privilege

- Client applied **SCPs (Service Control Policies)** at the AWS Organisation level
- Each Lambda has a **dedicated execution role** scoped to exactly the resources it needs
- No Lambda has admin, IAM, or cross-account permissions
- No IAM user access keys used — all access is role-based

### 5. DynamoDB — PITR Enabled

Point-in-Time Recovery (PITR) is enabled on the DynamoDB table:
- Continuous backups retained for **35 days**
- Supports restore to any second within that window
- Required for HIPAA audit readiness and disaster recovery

### 6. CloudWatch Logging — Designed for HIPAA Compliance

All four Lambda functions were written with deliberate CloudWatch log hygiene. This was a design requirement, not an afterthought.

**What IS logged (safe):**
- `patientId` — internal PB system ID, not a health record number
- GHL response **status codes** only (e.g. `200`, `409`) — never response bodies
- DDB status transitions (e.g. `PENDING_TO_GHL → SUCCESS`)
- Tag **key names** only (e.g. `YOUTH_CORE_MEMBER`) — non-clinical membership labels
- Error names (e.g. `ConditionalCheckFailedException`) — no error message bodies
- Operational events (Lambda start/end, secrets loaded, cursor saved)

**What is NEVER logged:**
- Patient names (first name, last name)
- Email addresses
- Phone numbers
- GHL API response bodies (may contain contact data)
- PB API response bodies (may contain clinical data)
- OAuth tokens or API keys
- Raw event payloads

**How this is enforced in code:**

```javascript
// SAFE — explicit fields only, no raw payload
console.log("[MAIN] Patient fetched from PB, patientId:", patient.id);
console.log("[GHL] Response status:", res.status); // status code only

// NEVER done — would log PHI
// console.log("Patient data:", patient);
// console.log("GHL response:", await res.json());
```

**Lambda 2 additional protection — loop prevention without PHI exposure:**
The change-detection logic compares field values internally but only logs the `patientId` and outcome — not the field values being compared.

CloudWatch log groups have a **90-day retention policy**. Log groups are defined in CloudFormation and created automatically on first deployment.

### 7. API Gateway — GHL Webhook Security

- GHL webhook endpoint (`POST /webhook/ghl`) validates a shared secret on every request
- Secret retrieved from SSM — not hardcoded
- Requests without a valid secret return `401 Unauthorized` immediately

---

## AWS Services — BAA Coverage

All services used in this integration are covered under the AWS BAA:

| Service | BAA Covered |
|---|---|
| AWS Lambda | ✅ |
| Amazon EventBridge | ✅ |
| Amazon API Gateway | ✅ |
| Amazon DynamoDB | ✅ |
| AWS Systems Manager (SSM) | ✅ |
| Amazon CloudWatch | ✅ |
| AWS KMS | ✅ |

Reference: [AWS HIPAA Eligible Services](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/)

---

## Threat Model

| Threat | Mitigation |
|---|---|
| Unauthorised GHL webhook submission | Shared secret validation on API Gateway |
| PHI leaking to GHL | Lambda 1 only forwards non-PHI fields — enforced in code |
| Credential exposure | SSM SecureString; no env vars; no hardcoded keys |
| Duplicate patient records in GHL | Lambda 1 checks GHL before creating a contact |
| Data loss on Lambda failure | DynamoDB status stays `PENDING_TO_PB`; auto-retried on next trigger |
| Missed patients (Lambda 1 fetch limit) | Retry Lambda (every 10 min) recovers missed records |
| Unauthorised DynamoDB access | Least-privilege IAM; KMS encryption; no public access |
| PHI in CloudWatch logs | Explicit field logging only; no raw payload serialisation |
| Stale unprocessed records | CloudWatch alarm fires if records stuck in `PENDING_TO_PB` > 30 min |

---

## Out of Scope

The following are the responsibility of the **client**, not this integration:

- Signing and maintaining the AWS BAA
- HIPAA compliance of Practice Better (client's responsibility with PB)
- Workforce training and access policies
- Physical safeguards
- Incident response and breach notification procedures
- Compliance of GoHighLevel (GHL receives no PHI)
