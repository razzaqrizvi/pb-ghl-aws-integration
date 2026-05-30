// ===============================================
// RETRY LAMBDA — DDB → GHL (SAFE, SMART RETRIES)
// Recovers patients missed by Lambda 1 due to
// fetch limits or transient errors.
// Runtime: Node.js 22.x | CommonJS | Native fetch
// ===============================================
// HIPAA note: No PHI logged. Logs contain only
// patientId (internal system ID), GHL response
// status codes, retry outcomes, and DDB status
// transitions. No names, emails, or clinical data
// appear in CloudWatch logs.
// ===============================================

const {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand
} = require("@aws-sdk/client-dynamodb");

const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require("@aws-sdk/client-secrets-manager");

const ddb           = new DynamoDBClient({});
const secretsClient = new SecretsManagerClient({});

// ----------------------------------
// CONSTANTS
// Table name and secret name injected via Lambda environment
// variables. Actual values live in AWS — never hardcoded here.
// ----------------------------------
const TABLE_NAME = process.env.SYNC_TABLE_NAME; // e.g. "BridgeStateTable"
const SECRET_ID  = process.env.PB_SECRET_NAME;  // e.g. "PBSecret-Prod"

const STATUS_PENDING = "PENDING_TO_GHL";
const MAX_RECORDS    = 1;   // Safe prod default — increase after validation
const DRY_RUN        = false;

// ----------------------------------
// Load Secrets from AWS Secrets Manager
// ----------------------------------
async function loadSecrets() {
  console.log("[INIT] Loading secrets from Secrets Manager");
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_ID })
  );
  console.log("[INIT] Secrets loaded successfully");
  return JSON.parse(res.SecretString);
}

// ----------------------------------
// Scan DDB for PENDING_TO_GHL records
// No Limit on Scan — filter in code for accuracy.
// DynamoDB Scan Limit filters before filter expression,
// which can return fewer results than expected.
// ----------------------------------
async function getPendingRecords() {
  console.log("[SCAN] Scanning DDB for PENDING_TO_GHL records", {
    maxRecords: MAX_RECORDS
  });

  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#s = :pending",
      ExpressionAttributeNames:  { "#s": "status" },
      ExpressionAttributeValues: { ":pending": { S: STATUS_PENDING } }
      // No Limit here — intentional (see comment above)
    })
  );

  const items        = res.Items || [];
  const limitedItems = items.slice(0, MAX_RECORDS);

  console.log("[SCAN] Scan complete", {
    scannedCount:  res.ScannedCount,
    matchedCount:  items.length,
    returnedCount: limitedItems.length
  });

  return limitedItems;
}

// ----------------------------------
// Retry Send to GHL with Smart Classification
// Response outcomes drive DDB status updates.
// Only status code logged — no response body (HIPAA safe).
// ----------------------------------
async function retrySendToGHL(item, secrets) {
  const patientId = item.patientId?.S;
  console.log("[GHL] Preparing retry attempt", { patientId });

  const payload = {
    firstName:    item.firstName?.S || "",
    lastName:     item.lastName?.S  || "",
    email:        item.email?.S     || "",
    phone:        item.phone?.S     || "",
    tags:         ["pb post consultation"],
    locationId:   secrets.GHL_LOCATION_ID,
    customFields: [
      {
        id:          secrets.GHL_CUSTOM_FIELD_ID,
        key:         secrets.GHL_CUSTOM_FIELD_KEY,
        field_value: patientId
      }
    ]
  };

  if (DRY_RUN) {
    console.log("[GHL] DRY_RUN — skipping API call", { patientId });
    return { outcome: "DRY_RUN" };
  }

  try {
    console.log("[GHL] Sending retry request", { patientId });

    const res = await fetch("https://services.leadconnectorhq.com/contacts/", {
      method:  "POST",
      headers: {
        Authorization: `Bearer ${secrets.GHL_API_KEY}`,
        "Content-Type": "application/json",
        Version: "2021-07-28"
      },
      body: JSON.stringify(payload)
    });

    // Log status code only — not body (may contain contact data)
    console.log("[GHL] Response received", { patientId, statusCode: res.status });

    let body = {};
    try { body = await res.json(); } catch {}

    if (res.ok)          return { outcome: "SUCCESS" };
    if (res.status === 409) return { outcome: "ALREADY_EXISTS" };

    if (res.status === 400) {
      const msg = JSON.stringify(body).toLowerCase();
      if (msg.includes("already") || msg.includes("exists")) {
        return { outcome: "ALREADY_EXISTS" };
      }
      return { outcome: "FAILED_VALIDATION" };
    }

    if (res.status === 401 || res.status === 403) return { outcome: "FAILED_AUTH" };

    return { outcome: "FAILED_UNKNOWN" };

  } catch (err) {
    console.error("[GHL] Network error", { patientId, error: err.message });
    return { outcome: "RETRY_NETWORK" };
  }
}

// ----------------------------------
// Update DDB Status — Conditional Write
// Condition ensures only PENDING_TO_GHL records are updated,
// preventing race conditions with Lambda 1.
// ----------------------------------
async function updateStatus(pk, newStatus) {
  console.log("[DDB] Updating status", { pk, newStatus });

  await ddb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: pk } },
      UpdateExpression: "SET #s = :s, updated_at = :u",
      ConditionExpression: "#s = :pending",
      ExpressionAttributeNames:  { "#s": "status" },
      ExpressionAttributeValues: {
        ":s":       { S: newStatus },
        ":pending": { S: STATUS_PENDING },
        ":u":       { S: new Date().toISOString() }
      }
    })
  );

  console.log("[DDB] Status updated successfully", { pk, newStatus });
}

// ----------------------------------
// HANDLER
// ----------------------------------
exports.handler = async () => {
  console.log("[START] Retry Lambda started");

  const secrets = await loadSecrets();
  const records = await getPendingRecords();

  console.log("[MAIN] Pending records to process", { count: records.length });

  if (records.length === 0) {
    console.log("[MAIN] No eligible records — exiting cleanly");
    return { status: "OK" };
  }

  for (const item of records) {
    const patientId = item.patientId?.S;
    const pk        = item.pk?.S;

    console.log("[MAIN] Processing record", { patientId });

    const result = await retrySendToGHL(item, secrets);
    console.log("[MAIN] Retry outcome", { patientId, outcome: result.outcome });

    switch (result.outcome) {
      case "SUCCESS":
        await updateStatus(pk, "SUCCESS(SENT_TO_GHL)");
        break;
      case "ALREADY_EXISTS":
        await updateStatus(pk, "SUCCESS(ALREADY_EXISTS)");
        break;
      case "FAILED_VALIDATION":
        await updateStatus(pk, "FAILED_VALIDATION");
        break;
      case "FAILED_AUTH":
        await updateStatus(pk, "FAILED_AUTH");
        break;
      case "RETRY_NETWORK":
        // Leave as PENDING_TO_GHL — will retry on next EventBridge trigger
        console.log("[MAIN] Network error — will retry on next trigger", { patientId });
        break;
      default:
        console.log("[MAIN] No state change for outcome", { outcome: result.outcome });
    }
  }

  console.log("[END] Retry Lambda completed");
  return { status: "OK" };
};
