# Architecture — Deep Dive

## Overview

This integration uses AWS as a **stateful, HIPAA-compliant sync bridge** between Practice Better (HMS) and GoHighLevel (CRM). The bridge is fully serverless — no EC2, no containers, no always-on infrastructure.

The core design principle is **status-driven orchestration**: DynamoDB is not just a cache but the **source of truth for sync state**. Every record has a status that drives which Lambda acts on it next.

---

## Why Not Zapier?

Zapier supports both Practice Better and GoHighLevel natively. However:

- GoHighLevel does not sign a HIPAA Business Associate Agreement (BAA)
- Zapier's data handling cannot be scoped to exclude PHI in transit
- The client required a fully auditable, controllable pipeline within their own AWS account

AWS was chosen because:
- AWS signs a BAA covering all services used in this integration
- The client already had an AWS account with HIPAA-aligned SCPs and guardrails
- Serverless Lambda + EventBridge gives a reliable, low-cost polling mechanism

---

## Component Detail

### Lambda 1 — `pb-to-ghl` (PB → DDB → GHL)

**Trigger:** EventBridge scheduled rule — every **5 minutes**

**Responsibilities:**
1. Calls the Practice Better API to fetch new or recently updated patients
2. Applies a configurable **fetch limit** (intentionally set low to avoid PB API rate limits and Lambda timeouts)
3. For each patient:
   - Checks if the patient already exists in DynamoDB
   - If new: writes a DynamoDB record with status `PENDING_TO_GHL` (pending) → `SUCCESS` (sent)
   - Calls the GHL API to create/update the contact (non-PHI fields only)
   - If GHL contact already exists: skips creation, logs to CloudWatch
4. Any patients beyond the fetch limit are picked up by the **Retry Lambda** on the next 10-minute cycle

**Key design decisions:**
- Fetch limit prevents Lambda timeout (15-minute hard limit) and PB API throttling
- Idempotent GHL write — check before create avoids duplicate contacts
- DynamoDB write happens before GHL API call — if GHL call fails, the record is in DDB and the retry Lambda can recover it

---

### Lambda 2 — `ghl-webhook` (GHL → DDB)

**Trigger:** API Gateway `POST /webhook/ghl` — fires on any GHL contact change

**Responsibilities:**
1. Receives GHL webhook payload (profile changes, membership plan changes, membership status changes)
2. Validates the webhook (signature or shared secret from SSM)
3. Looks up the DynamoDB record by GHL contact ID or email
4. Updates the record with the changed fields
5. Sets record status to `PENDING_TO_PB`
6. Returns `200 OK` to GHL immediately (async processing from here)

**What GHL changes are captured:**
- Contact profile fields (name, phone, email)
- Membership plan assignment
- Membership status (active, cancelled, paused, etc.)
- Custom tags applied in GHL

**What is NOT stored in DynamoDB:**
- Any clinical data (GHL doesn't hold it)
- PHI fields (not applicable — GHL contact data is non-clinical)

---

### Lambda 3 — `ddb-to-pb` (DDB → PB)

**Trigger:** EventBridge scheduled rule — every **5 minutes**

**Responsibilities:**
1. Scans DynamoDB for all records with status `PENDING_TO_PB`
2. For each record:
   - Calls PB API — **Tags update** (membership tags, status tags)
   - Calls PB API — **Membership plan and status update**
3. On success: updates DynamoDB record status to `SYNC_COMPLETED`
4. On failure: leaves status as `PENDING_TO_PB` — the record will be retried automatically on the next 5-minute trigger

**Built-in retry mechanism:**
- No separate retry queue needed — EventBridge re-triggers every 5 minutes
- Failed records naturally retry until they succeed
- CloudWatch alarm fires if a record has been `PENDING_TO_PB` for longer than a configurable threshold

**PB APIs used:**
1. `/clients/{id}/tags` — update membership and status tags
2. `/clients/{id}/memberships` — update membership plan and status

---

### Lambda 4 — `retry` (Missed Record Recovery)

**Trigger:** EventBridge scheduled rule — every **10 minutes**

**Responsibilities:**
1. Scans DynamoDB for records that should have been processed by Lambda 1 but were missed
2. Missed records are identified by:
   - Status not yet `PENDING_TO_GHL` (pending) → `SUCCESS` (sent) (Lambda 1 did not complete for them)
   - Timestamp older than the Lambda 1 fetch window
3. Re-attempts the PB → GHL sync for each missed patient
4. Designed to handle edge cases: PB API rate limits, Lambda 1 fetch limit being hit, transient errors

**Why a separate Lambda?**
- Lambda 1 has an intentional fetch limit. For practices with large patient volumes, new patients beyond the limit on any given 5-minute window would be missed without this safety net.
- Separating concerns keeps Lambda 1 fast and within timeout bounds.

---

## DynamoDB Schema

### Table: `pb-ghl-sync` (name sanitised)

| Attribute | Type | Description |
|---|---|---|
| `patientId` | String (PK) | Practice Better patient ID |
| `ghlContactId` | String | GoHighLevel contact ID |
| `email` | String | Used for GHL deduplication |
| `syncStatus` | String | `PENDING_TO_GHL` (pending) → `SUCCESS` (sent) / `PENDING_TO_PB` / `SYNC_COMPLETED` |
| `lastUpdatedAt` | String (ISO 8601) | Timestamp of last DDB write |
| `pendingChanges` | Map | Fields from GHL waiting to be pushed to PB |
| `membershipPlan` | String | Current membership plan name |
| `membershipStatus` | String | active / cancelled / paused |
| `tags` | List | GHL tags to be synced to PB |
| `retryCount` | Number | Number of failed sync attempts |
| `errorLog` | String | Last error message (no PHI) |

**PITR (Point-in-Time Recovery):** Enabled — allows restore to any second within the last 35 days.

**Encryption:** KMS Customer Managed Key.

---

## AWS Secrets Manager — Secret Structure

All secrets are stored in **AWS Secrets Manager** as a single JSON secret per environment. Secret names are injected into Lambda via environment variables — never hardcoded.

**Lambda environment variable:** `PB_SECRET_NAME` → points to the Secrets Manager secret ARN/name

**Secret JSON structure** (keys only — values never in this repo):

```json
{
  "client_id":            "YOUR_PB_CLIENT_ID",
  "client_secret":        "YOUR_PB_CLIENT_SECRET",
  "token_url":            "YOUR_PB_TOKEN_URL",
  "PB_GRANT_TYPE":        "client_credentials",
  "GHL_API_KEY":          "YOUR_GHL_API_KEY",
  "GHL_LOCATION_ID":      "YOUR_GHL_LOCATION_ID",
  "GHL_CUSTOM_FIELD_ID":  "YOUR_GHL_CUSTOM_FIELD_ID",
  "GHL_CUSTOM_FIELD_KEY": "YOUR_GHL_CUSTOM_FIELD_KEY"
}
```

Lambdas load secrets once at cold start and cache in-memory for the function lifetime. No secrets exist in environment variables, code, or CloudFormation parameter values.

---

## CloudWatch Alarms

| Alarm | Condition | Action |
|---|---|---|
| Lambda 1 errors | Error rate > 1% over 5 min | SNS → email |
| Lambda 2 errors | Error rate > 1% over 5 min | SNS → email |
| Lambda 3 errors | Error rate > 1% over 5 min | SNS → email |
| Retry Lambda errors | Error rate > 1% over 10 min | SNS → email |
| Stale PENDING_TO_PB | Records older than 30 min | SNS → email |
| Lambda duration P99 | > 10 seconds | SNS → email |

---

## EventBridge Schedule Summary

| Rule | Lambda | Frequency | Purpose |
|---|---|---|---|
| `pb-to-ghl-schedule` | Lambda 1 | Every 5 min | Fetch new PB patients → GHL |
| `ddb-to-pb-schedule` | Lambda 3 | Every 5 min | Push GHL changes → PB |
| `retry-schedule` | Lambda 4 | Every 10 min | Recover missed records |

---

## IAM — Least Privilege Summary

Each Lambda has its own execution role. The client applied SCPs at the AWS Organisation level to enforce boundaries.

| Lambda | DynamoDB | SSM | CloudWatch | Other |
|---|---|---|---|---|
| pb-to-ghl | `PutItem`, `GetItem` | `GetParameter` (PB + GHL paths) | `CreateLogGroup`, `PutLogEvents` | — |
| ghl-webhook | `UpdateItem`, `GetItem` | `GetParameter` (GHL webhook secret) | `CreateLogGroup`, `PutLogEvents` | — |
| ddb-to-pb | `Scan`, `UpdateItem` | `GetParameter` (PB path) | `CreateLogGroup`, `PutLogEvents` | — |
| retry | `Scan`, `UpdateItem` | `GetParameter` (PB + GHL paths) | `CreateLogGroup`, `PutLogEvents` | — |

No Lambda has `DeleteItem`, `CreateTable`, or any IAM/admin permissions.

---

## Decision Log

| Decision | Rationale |
|---|---|
| Polling (EventBridge) instead of PB webhooks | PB does not support outbound webhooks reliably for all event types |
| DynamoDB status field as orchestration driver | Simple, auditable, no additional queue infrastructure needed |
| Built-in retry via EventBridge re-trigger | Avoids SQS/DLQ complexity for this use case; 5-min polling is sufficient |
| SSM Parameter Store over Secrets Manager | Client's existing AWS setup used SSM; consistent with their tooling |
| Separate Retry Lambda | Keeps Lambda 1 fast and within safe timeout bounds; separation of concerns |
| Node.js 22.x | Latest LTS Lambda runtime; consistent with client's existing Lambda stack |
| PITR on DynamoDB | Required for HIPAA audit readiness and disaster recovery |
