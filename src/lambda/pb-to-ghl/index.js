// ===============================================
// LAMBDA 1 — PB → AWS (DynamoDB) → GHL
// SAFE MODE (SINGLE RECORD, CREATE-ONLY)
// WITH STRONG LOGGING & FAILURE VISIBILITY
// Runtime: Node.js 22.x | CommonJS | Native fetch
// ===============================================

const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require("@aws-sdk/client-secrets-manager");

const {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand
} = require("@aws-sdk/client-dynamodb");

const secretsClient = new SecretsManagerClient({});
const ddb = new DynamoDBClient({});

// ----------------------------------
// CONSTANTS
// Table name and secret name injected via Lambda environment variables.
// Actual values live in AWS — never hardcoded here.
// ----------------------------------
const TABLE_NAME = process.env.SYNC_TABLE_NAME;  // e.g. "BridgeStateTable"
const STATE_PK   = "PB_STATE";

const PB_CLIENTS_URL = "https://api.practicebetter.io/consultant/records";
const PB_TOKEN_URL   = "https://api.practicebetter.io/oauth2/token";

// ----------------------------------
// Load Secrets from AWS Secrets Manager
// Secret name injected via environment variable — never hardcoded.
// Secret JSON contains: client_id, client_secret, token_url,
// GHL_API_KEY, GHL_LOCATION_ID, GHL_CUSTOM_FIELD_ID, GHL_CUSTOM_FIELD_KEY
// ----------------------------------
async function loadSecrets() {
  console.log("[INIT] Loading secrets from Secrets Manager");
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.PB_SECRET_NAME })
  );
  console.log("[INIT] Secrets loaded successfully");
  return JSON.parse(res.SecretString);
}

// ----------------------------------
// OAuth — Practice Better Access Token
// Logs outcome only — no token value logged (HIPAA safe)
// ----------------------------------
async function getPBToken(secrets) {
  console.log("[AUTH] Fetching PB access token");
  const body = new URLSearchParams({
    grant_type:    secrets.PB_GRANT_TYPE || "client_credentials",
    client_id:     secrets.client_id,
    client_secret: secrets.client_secret
  });

  const res = await fetch(secrets.token_url || PB_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    console.error("[AUTH] PB token fetch failed", { status: res.status });
    throw new Error("PB token fetch failed");
  }

  console.log("[AUTH] PB token acquired successfully");
  return json.access_token;
}

// ----------------------------------
// Cursor Helpers
// Cursor tracks the last-processed updatedAt timestamp so each
// Lambda invocation fetches only new/updated patients.
// Cursor stored in DDB under reserved key PB_STATE.
// ----------------------------------
async function getCursor() {
  const r = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: STATE_PK } }
    })
  );
  return r.Item?.lastProcessedAt?.S || null;
}

async function saveCursor(ts) {
  console.log("[CURSOR] Saving cursor:", ts);
  await ddb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: STATE_PK } },
      UpdateExpression: "SET lastProcessedAt = :t, updated_at = :u",
      ExpressionAttributeValues: {
        ":t": { S: ts },
        ":u": { S: new Date().toISOString() }
      }
    })
  );
}

function extractCursor(patient) {
  return (
    patient.updatedAt  ||
    patient.updated    ||
    patient.createdAt  ||
    patient.created    ||
    new Date().toISOString()
  );
}

// ----------------------------------
// Fetch ONE Patient from Practice Better
// Intentionally limited to 1 record per invocation to:
//   1. Avoid PB API rate limits
//   2. Stay well within Lambda 15-min timeout
//   3. Ensure clean cursor advancement per run
// Missed patients are recovered by the Retry Lambda.
// ----------------------------------
async function fetchOnePB(pbToken, cursor) {
  let url = `${PB_CLIENTS_URL}?limit=1`;
  if (cursor) url += `&updatedAfter=${encodeURIComponent(cursor)}`;

  console.log("[PB] Fetching patient from PB API");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pbToken}`,
      Accept: "application/json"
    }
  });

  const json = await res.json();

  if (!res.ok) {
    console.error("[PB] Fetch failed", { status: res.status });
    throw new Error("PB fetch failed");
  }

  return json.items?.[0] || null;
}

// ----------------------------------
// Write to DynamoDB — CREATE ONLY
// Conditional write (attribute_not_exists) ensures existing
// records are never overwritten by this Lambda.
// HIPAA note: only non-PHI fields stored (name, email, phone
// are contact fields, not clinical data).
// ----------------------------------
async function createIfNotExists(patient) {
  const now = new Date().toISOString();

  try {
    console.log("[DDB] Attempting insert for patientId:", patient.id);

    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk:            { S: patient.id.toString() },
          patientId:     { S: patient.id.toString() },
          firstName:     { S: patient.profile?.firstName    || "" },
          lastName:      { S: patient.profile?.lastName     || "" },
          email:         { S: patient.profile?.emailAddress || "" },
          phone:         { S: patient.profile?.mobilePhone  || "" },
          tag:           { S: "pb post consultation" }, // non-clinical tag only
          status:        { S: "PENDING_TO_GHL" },
          lastUpdatedBy: { S: "PB" },
          updated_at:    { S: now }
        },
        ConditionExpression: "attribute_not_exists(pk)"
      })
    );

    console.log("[DDB] Insert SUCCESS for patientId:", patient.id);
    return true;

  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("[DDB] Patient already exists — skipping:", patient.id);
      return false;
    }
    console.error("[DDB] Insert failed", { error: err.name });
    throw err;
  }
}

// ----------------------------------
// Send Patient to GoHighLevel CRM
// HIPAA note: only non-PHI fields forwarded.
// No clinical data leaves AWS.
// ----------------------------------
async function sendToGHL(patient, secrets) {
  const payload = {
    firstName:    patient.profile?.firstName    || "",
    lastName:     patient.profile?.lastName     || "",
    email:        patient.profile?.emailAddress || "",
    phone:        patient.profile?.mobilePhone  || "",
    tags:         ["pb post consultation"],
    locationId:   secrets.GHL_LOCATION_ID,
    customFields: [
      {
        id:          secrets.GHL_CUSTOM_FIELD_ID,
        key:         secrets.GHL_CUSTOM_FIELD_KEY,
        field_value: patient.id.toString() // PB patient ID for GHL deduplication
      }
    ]
  };

  console.log("[GHL] Sending patient to GHL, patientId:", patient.id);

  const res = await fetch("https://services.leadconnectorhq.com/contacts/", {
    method:  "POST",
    headers: {
      Authorization: `Bearer ${secrets.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28"
    },
    body: JSON.stringify(payload)
  });

  // Log status only — response body may contain contact info (HIPAA safe)
  console.log("[GHL] Response status:", res.status);

  return res.ok;
}

// ----------------------------------
// HANDLER
// ----------------------------------
exports.handler = async () => {
  console.log("[START] Lambda 1 (pb-to-ghl) started");

  const secrets = await loadSecrets();
  const token   = await getPBToken(secrets);

  const cursor = await getCursor();
  console.log("[CURSOR] Current cursor:", cursor);

  const patient = await fetchOnePB(token, cursor);

  if (!patient) {
    console.log("[MAIN] No new PB records found — exiting cleanly");
    return { status: "OK" };
  }

  console.log("[MAIN] Patient fetched from PB, patientId:", patient.id);

  const created = await createIfNotExists(patient);

  if (created) {
    const sent = await sendToGHL(patient, secrets);

    if (sent) {
      console.log("[MAIN] GHL send SUCCESS — updating DDB status");

      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { pk: { S: patient.id.toString() } },
          UpdateExpression: "SET #s = :s, updated_at = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": { S: "SUCCESS" },
            ":u": { S: new Date().toISOString() }
          }
        })
      );
    } else {
      // Record stays PENDING_TO_GHL — Retry Lambda will pick it up
      console.error("[MAIN] GHL send FAILED — record remains PENDING_TO_GHL for retry");
    }
  }

  const cursorValue = extractCursor(patient);
  await saveCursor(cursorValue);

  console.log("[END] Lambda 1 completed successfully");
  return { status: "OK" };
};
