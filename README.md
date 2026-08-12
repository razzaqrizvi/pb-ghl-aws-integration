# PB ↔ GHL AWS Sync Bridge

> **HIPAA-Compliant, Serverless, Bidirectional Sync between Practice Better and GoHighLevel — using AWS as a secure data bridge.**

Built for a health and wellness practice operating in the **USA and Canada**. The client required a cloud-native alternative to Zapier due to HIPAA compliance constraints — GoHighLevel does not sign a BAA, so zero PHI is forwarded to GHL. AWS signs a BAA and provides the compliant bridge layer.

---

## The Problem

[Practice Better](https://www.practicebetter.io/) (PB) is the client's Healthcare Management System (HMS). It holds the source of truth for patient records.

[GoHighLevel](https://www.gohighlevel.com/) (GHL) is the CRM used for marketing automation — membership status updates, automated emails, tagging, and follow-up workflows.

**The challenge:** PB does not natively support automation triggers. Zapier integration exists but is not HIPAA-compliant for this use case. The client needed a fully controlled, auditable, HIPAA-aligned sync bridge — with AWS as the intermediary.

---

## Solution: AWS Sync Bridge

AWS acts as a **secure middle layer** — receiving data from both systems, storing it in DynamoDB, and orchestrating the sync in both directions. No PHI ever reaches GoHighLevel.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         STEP 1: PB → GHL                                 │
│                                                                          │
│   EventBridge (every 5 min)                                              │
│         │                                                                │
│         ▼                                                                │
│   Lambda 1: pb-to-ghl                                                    │
│         │  • Calls PB API — fetches new/updated patients                 │
│         │  • Writes records to DynamoDB (status: SENT_TO_GHL)            │
│         │  • Calls GHL API — creates/updates contact (non-PHI only)      │
│         │  • If contact already exists in GHL → skips, logs              │
│         ▼                                                                │
│      DynamoDB ←──────────────────────────────────────────────────────┐  │
│                                                                       │  │
├───────────────────────────────────────────────────────────────────────┼──┤
│                         STEP 2: GHL → DDB                            │  │
│                                                                       │  │
│   GHL Webhook (on any contact/membership change)                      │  │
│         │                                                             │  │
│         ▼                                                             │  │
│   API Gateway (REST endpoint)                                         │  │
│         │                                                             │  │
│         ▼                                                             │  │
│   Lambda 2: ghl-webhook                                               │  │
│         │  • Receives GHL payload                                     │  │
│         │  • Updates DynamoDB record (status: PENDING_TO_PB)          │  │
│         │  • Captures: profile changes, membership plan, status       │  │
│         └──────────────────────────────────────────────────────────▶ │  │
│                                                                       │  │
├───────────────────────────────────────────────────────────────────────┼──┤
│                         STEP 3: DDB → PB                             │  │
│                                                                       │  │
│   EventBridge (every 5 min)                                          │  │
│         │                                                             │  │
│         ▼                                                             │  │
│   Lambda 3: ddb-to-pb                                                 │  │
│         │  • Scans DDB for status: PENDING_TO_PB                      │  │
│         │  • Calls PB API:                                            │  │
│         │      1) Tags update                                          │  │
│         │      2) Membership plan + status update                     │  │
│         │  • On success → updates DDB status: SYNC_COMPLETED          │  │
│         │  • On failure → leaves status as PENDING_TO_PB (retries     │  │
│         │    automatically on next EventBridge trigger)                │  │
│         └──────────────────────────────────────────────────────────▶ │  │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                    FINAL STEP: Retry Lambda                              │
│                                                                          │
│   EventBridge (every 10 min)                                             │
│         │                                                                │
│         ▼                                                                │
│   Lambda 4: retry                                                        │
│         │  • Checks DDB for any records missed by Lambda 1              │
│         │  • Re-attempts PB → GHL sync for missed patients              │
│         │  • Handles PB API fetch limits & Lambda timeout edge cases     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Supporting Services (all within AWS HIPAA BAA scope):
┌─────────────────────────────────────────────────────┐
│  DynamoDB         — Central sync state + audit log  │
│  SSM Param Store  — Encrypted secrets & config      │
│  CloudWatch       — Structured logs + alarms        │
│  API Gateway      — GHL webhook receiver            │
│  EventBridge      — Scheduled Lambda triggers       │
│  KMS              — Encryption at rest              │
└─────────────────────────────────────────────────────┘
```

---

## DynamoDB Sync Status Flow

```
[New PB Patient Detected]
         │
         ▼
  PENDING_TO_GHL        ← Lambda 1 writes on first DDB insert
         │
         │   Lambda 1 successfully calls GHL API
         ▼
      SUCCESS           ← Lambda 1 updates on confirmed GHL send
         │
         │   GHL webhook fires (profile / membership change)
         ▼
  PENDING_TO_PB         ← Lambda 2 writes on GHL webhook receipt
         │
         │   Lambda 3 successfully pushes changes back to PB
         ▼
  SYNC_COMPLETED        ← Lambda 3 writes on successful PB update
```

If Lambda 1 fails to reach GHL, the record stays `PENDING_TO_GHL` — the Retry Lambda (every 10 min) picks it up. If Lambda 3 fails to reach PB, the record stays `PENDING_TO_PB` and is automatically retried on the next 5-minute trigger.

---

## Repository Structure

```
pb-ghl-aws-integration/
├── README.md
├── docs/
│   ├── architecture.md          # Deep-dive: components, decisions, data flow
│   ├── hipaa-compliance.md      # HIPAA controls, BAA scope, threat model
│   ├── data-mapping.md          # PB ↔ GHL field mapping, PHI exclusions
│   └── branching-strategy.md   # Git workflow and branch conventions
├── src/
│   └── lambda/
│       ├── pb-to-ghl/           # Lambda 1: PB API → DDB → GHL API
│       ├── ghl-webhook/         # Lambda 2: GHL Webhook → DDB
│       ├── ddb-to-pb/           # Lambda 3: DDB → PB API
│       └── retry/               # Lambda 4: Missed-record retry
├── infrastructure/
│   └── cloudformation/
│       └── template.yaml        # IaC — all AWS resources
└── .github/
    └── workflows/
        ├── ci.yml               # PR checks: lint + unit tests
        └── deploy.yml           # Deploy on merge to main/develop
```

---

## AWS Services Used

| Service | Purpose | HIPAA BAA |
|---|---|---|
| AWS Lambda (Node.js 22.x) | Sync logic for all 4 functions | ✅ |
| Amazon EventBridge | Scheduled triggers (5 min / 10 min) | ✅ |
| Amazon API Gateway | GHL webhook receiver endpoint | ✅ |
| Amazon DynamoDB | Central sync state + audit (PITR enabled) | ✅ |
| AWS Systems Manager (SSM) | Encrypted secrets, API keys, config | ✅ |
| Amazon CloudWatch | Structured logs, alarms | ✅ |
| AWS KMS | Encryption at rest | ✅ |

---

## Security & HIPAA Highlights

- **Zero PHI sent to GoHighLevel** — GHL is not HIPAA-compliant; only non-identifying data (tags, membership status) is forwarded
- **SSM Parameter Store** — all API keys, GHL Location IDs, PB custom field IDs stored encrypted; no secrets in code or environment variables
- **Least-privilege IAM** — client applied SCPs; each Lambda has a scoped execution role
- **DynamoDB PITR** — Point-in-Time Recovery enabled for audit and disaster recovery
- **CloudWatch structured logging** — no PHI in log fields
- **AWS BAA** — client's AWS account is enrolled in the AWS BAA covering all services used

Full details: [`docs/hipaa-compliance.md`](docs/hipaa-compliance.md)

---

## Branching Strategy

| Branch | Purpose |
|---|---|
| `main` | Production — protected, deploy on merge |
| `develop` | Integration — all features merged here first |
| `feature/lambda-*` | Individual Lambda development |
| `hotfix/*` | Urgent production fixes |

Full conventions: [`docs/branching-strategy.md`](docs/branching-strategy.md)

---

## Author

**Razzaq Rizvi** — Cloud & Infrastructure Engineer

- LinkedIn: <https://www.linkedin.com/in/razzaqrizvi/>
- GitHub: <https://github.com/razzaqrizvi>

---

## License

MIT — sanitised reference implementation. All credentials, PHI, client-specific identifiers, and proprietary business logic have been removed. Placeholder values marked with `YOUR_*` throughout.
