# Data Mapping: PB ↔ GHL Bidirectional Sync

This document defines what data flows in each direction, which fields are mapped, and which are explicitly excluded at each stage of the sync bridge.

---

## Direction 1: Practice Better → GoHighLevel (Lambda 1)

### PB Patient → GHL Contact

| PB Field | GHL Field | Transformation | PHI? |
|---|---|---|---|
| `id` | Custom field: `pb_patient_id` | Direct map — stored for deduplication | No |
| `firstName` | `firstName` | Direct map | No |
| `lastName` | `lastName` | Direct map | No |
| `email` | `email` | Direct map — primary deduplication key | No |
| `phone` | `phone` | Normalised to E.164 format | No |
| `membershipPlan` | Custom field: `membership_plan` | Direct map | No |
| `membershipStatus` | Custom field: `membership_status` | Direct map | No |

### Fields Excluded from GHL (PHI or Not Required)

| PB Field | Reason Excluded |
|---|---|
| `dateOfBirth` | PHI |
| `sessionNotes` | PHI — clinical |
| `diagnosisCodes` | PHI — clinical |
| `medications` | PHI — clinical |
| `allergies` | PHI — clinical |
| `healthGoals` | PHI — sensitive |
| `treatmentPlan` | PHI — clinical |
| `insuranceDetails` | PHI — financial |
| `practitionerName` | Not required in GHL |
| `appointmentHistory` | PHI risk — clinical context |
| `customForms` | PHI risk — variable clinical content |
| `emergencyContact` | PHI — sensitive |

**Rule:** Only explicitly listed fields are forwarded. Any new fields added by Practice Better in future are excluded by default.

### GHL Tag Mapping (from PB membership data)

| PB Membership Status | GHL Tag Applied |
|---|---|
| `active` | `pb-active-member` |
| `cancelled` | `pb-cancelled-member` |
| `paused` | `pb-paused-member` |
| `expired` | `pb-expired-member` |
| `trial` | `pb-trial-member` |

Tags use the `pb-` prefix to distinguish Practice Better-sourced data from other GHL contact sources.

---

## Direction 2: GoHighLevel → Practice Better (Lambda 2 + Lambda 3)

### GHL Webhook → DynamoDB (`PENDING_TO_PB`)

Lambda 2 receives GHL webhook events and stores pending changes in DynamoDB.

#### Captured GHL Changes

| GHL Change | DDB Field Updated | Sent to PB |
|---|---|---|
| Contact profile update (name, phone) | `pendingChanges.profile` | Yes — via Lambda 3 |
| Membership plan change | `membershipPlan` | Yes — PB membership API |
| Membership status change | `membershipStatus` | Yes — PB membership API |
| Tag applied in GHL | `tags` | Yes — PB tags API |
| Tag removed in GHL | `tags` | Yes — PB tags API |

#### GHL Changes NOT forwarded to PB

| GHL Change | Reason |
|---|---|
| Opportunity / pipeline stage | CRM-only concept, no PB equivalent |
| Email open / click events | Marketing data, not clinical |
| SMS conversation history | Not applicable to PB |
| GHL internal notes | Not applicable to PB |
| Appointment (GHL native) | PB is the HMS source of truth for appointments |

### DynamoDB → Practice Better (Lambda 3)

Lambda 3 reads `PENDING_TO_PB` records and calls two PB APIs:

#### PB API 1: Tags Update

```
PATCH /clients/{pb_patient_id}/tags
Body: { "tags": ["pb-active-member", ...] }
```

SSM parameter used: `pb_custom_field_id_membership_tag`

#### PB API 2: Membership Plan + Status Update

```
PATCH /clients/{pb_patient_id}/memberships/{membership_id}
Body: {
  "planId": "{plan_id}",
  "status": "active"
}
```

SSM parameters used:
- `pb_custom_field_id_membership_status`
- `pb_base_url`

---

## DynamoDB Record — Full Schema

```json
{
  "patientId": "pb-patient-XXXXX",
  "ghlContactId": "ghl-contact-XXXXX",
  "email": "patient@example.com",
  "syncStatus": "SYNC_COMPLETED",
  "lastUpdatedAt": "2024-11-15T10:32:00Z",
  "membershipPlan": "Premium Wellness",
  "membershipStatus": "active",
  "tags": ["pb-active-member"],
  "pendingChanges": {},
  "retryCount": 0,
  "errorLog": null
}
```

**No PHI fields are stored in DynamoDB.** Patient names, phone numbers, and email are stored only to the extent necessary to call the destination API — and are classified as non-PHI for this use case (they are not linked to clinical records within this system).

---

## SSM Parameters Referenced in Code

Actual parameter names are not stored in this repository. The following naming convention is used:

| Parameter Path | Used By | Purpose |
|---|---|---|
| `/pb-ghl-sync/pb/api-key` | Lambda 1, 3, 4 | PB API authentication |
| `/pb-ghl-sync/pb/base-url` | Lambda 1, 3, 4 | PB API endpoint |
| `/pb-ghl-sync/pb/custom-field-ids/membership-tag` | Lambda 3 | PB custom field ID |
| `/pb-ghl-sync/pb/custom-field-ids/membership-status` | Lambda 3 | PB custom field ID |
| `/pb-ghl-sync/ghl/api-key` | Lambda 1, 4 | GHL API authentication |
| `/pb-ghl-sync/ghl/location-id` | Lambda 1, 4 | GHL sub-account ID |
| `/pb-ghl-sync/ghl/webhook-secret` | Lambda 2 | GHL webhook validation |

---

## Change Management

Any change to the field mapping requires:

1. Update to this document
2. Code change in the relevant Lambda
3. Review to confirm no PHI is introduced in the GHL direction
4. PR raised against `develop` branch — not deployed directly to `main`
5. Deployment via CI/CD pipeline only — no manual console changes
