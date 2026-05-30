// =====================================================
// LAMBDA 3 — DDB → PRACTICE BETTER TAG SYNC
// TAGS ONLY — PHI SAFE — PROD READY (FINAL CODE)
// Runtime: Node.js 22.x | CommonJS | Native fetch
// =====================================================
// HIPAA note: No PHI logged. Logs contain only
// patientId (internal system ID), tag key names
// (non-clinical labels), status transitions, and
// error codes. No names, emails, or clinical data
// appear in CloudWatch logs.
// =====================================================

const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require("@aws-sdk/client-secrets-manager");

const {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand
} = require("@aws-sdk/client-dynamodb");

const secretsClient = new SecretsManagerClient({});
const ddb = new DynamoDBClient({});

// ----------------------------------
// CONFIG
// Table name and secret name injected via Lambda environment
// variables. Actual values live in AWS — never hardcoded here.
// ----------------------------------
const TABLE_NAME     = process.env.SYNC_TABLE_NAME; // e.g. "BridgeStateTable"
const PB_SECRET_NAME = process.env.PB_SECRET_NAME;  // e.g. "PBSecret-Prod"

const PB_BASE_URL = "https://api.practicebetter.io";

const DRY_RUN    = false;
const MAX_RECORDS = 1;

const TARGET_STATUS  = "PENDING_TO_PB";
const SUCCESS_STATUS = "SYNC_COMPLETE";

// ----------------------------------
// UTILITIES
// ----------------------------------
const normalizeKey = v => v?.trim().toUpperCase().replace(/\s+/g, "_");
const safeTrim     = v => (typeof v === "string" ? v.trim() : v);

// ----------------------------------
// Load Secrets from AWS Secrets Manager
// ----------------------------------
async function loadSecrets() {
  console.log("[INIT] Loading secrets from Secrets Manager");
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: PB_SECRET_NAME })
  );
  console.log("[INIT] Secrets loaded successfully");
  return JSON.parse(res.SecretString);
}

// ----------------------------------
// Get PB OAuth Token
// Token value never logged (HIPAA safe)
// ----------------------------------
async function getPBToken(secrets) {
  console.log("[AUTH] Fetching PB access token");
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     secrets.client_id,
    client_secret: secrets.client_secret
  });

  const res = await fetch(secrets.token_url, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    console.error("[AUTH] PB token fetch failed", { status: res.status });
    throw new Error("PB OAuth failed");
  }

  console.log("[AUTH] PB token acquired successfully");
  return json.access_token;
}

// ----------------------------------
// Fetch PENDING_TO_PB records from DynamoDB
// MAX_RECORDS intentionally low — safe prod default
// ----------------------------------
async function fetchPendingRecords() {
  console.log("[SCAN] Scanning DDB for PENDING_TO_PB records");
  const items = [];
  let lastKey;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        Limit: MAX_RECORDS,
        ExclusiveStartKey: lastKey,
        FilterExpression: "#s = :v",
        ExpressionAttributeNames:  { "#s": "status" },
        ExpressionAttributeValues: { ":v": { S: TARGET_STATUS } }
      })
    );

    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey && items.length < MAX_RECORDS);

  const limited = items.slice(0, MAX_RECORDS);
  console.log("[SCAN] Records found", { count: limited.length });
  return limited;
}

// ----------------------------------
// Build PB Tag Actions
// Translates DDB tag/membership fields into PB API action objects.
// Uses secrets to resolve tag names → PB tag IDs.
// Non-PHI: tag names are non-clinical membership labels.
// ----------------------------------
function buildTagActions({ statusTagName, membershipPlanValue, secrets }) {
  const actions    = [];
  const logSummary = {
    status:     { removed: [], added: [] },
    membership: { removed: [], added: [] }
  };

  // Status tag
  if (statusTagName) {
    const normalized = normalizeKey(statusTagName);
    const newTagId   = secrets[normalized];

    if (!newTagId) {
      console.warn("[TAGS] Status tag not found in secrets", { normalized });
    } else {
      logSummary.status.removed = ["Active", "Cancelled"];
      logSummary.status.added   = [normalized];

      actions.push(
        { actionType: "remove", tagIds: [secrets.Active, secrets.Cancelled].filter(Boolean) },
        { actionType: "add",    tagIds: [newTagId] }
      );
    }
  }

  // Membership tags
  if (membershipPlanValue) {
    const desiredNames = membershipPlanValue
      .split(",")
      .map(v => normalizeKey(v));

    const desiredTags = desiredNames
      .map(name => ({ name, id: secrets[name] }))
      .filter(t => t.id);

    const missing = desiredNames.filter(n => !secrets[n]);
    if (missing.length) {
      console.warn("[TAGS] Membership tags not found in secrets", { missing });
    }

    if (desiredTags.length) {
      logSummary.membership.removed = ["YOUTH_CORE_MEMBER", "YOUTH_PRO_MEMBER"];
      logSummary.membership.added   = desiredTags.map(t => t.name);

      actions.push(
        { actionType: "remove", tagIds: [secrets.YOUTH_CORE_MEMBER, secrets.YOUTH_PRO_MEMBER].filter(Boolean) },
        { actionType: "add",    tagIds: desiredTags.map(t => t.id) }
      );
    }
  }

  return { actions, logSummary };
}

// ----------------------------------
// Update PB Tags via API
// ----------------------------------
async function updatePBTags({ token, patientId, actions }) {
  if (!actions.length) {
    console.warn("[PB] No valid tag actions — skipping", { patientId });
    return false;
  }

  if (DRY_RUN) {
    console.log("[PB] DRY_RUN — PB update skipped", { patientId });
    return true;
  }

  const res = await fetch(`${PB_BASE_URL}/consultant/taggables`, {
    method:  "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id: patientId, actions })
  });

  if (!res.ok) {
    console.error("[PB] Tag update failed", { patientId, status: res.status });
    throw new Error(`PB tag update failed: ${res.status}`);
  }

  return true;
}

// ----------------------------------
// Mark record as SYNC_COMPLETE in DynamoDB
// ----------------------------------
async function markComplete(patientId) {
  if (DRY_RUN) return;

  await ddb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: patientId } },
      UpdateExpression: "SET #s = :v",
      ExpressionAttributeNames:  { "#s": "status" },
      ExpressionAttributeValues: { ":v": { S: SUCCESS_STATUS } }
    })
  );
}

// ----------------------------------
// HANDLER
// ----------------------------------
exports.handler = async () => {
  console.log("[START] Lambda 3 (ddb-to-pb) started");

  const secrets = await loadSecrets();
  const token   = await getPBToken(secrets);
  const records = await fetchPendingRecords();

  for (const item of records) {
    const patientId = safeTrim(item.pk?.S);
    console.log("[MAIN] Processing record", { patientId });

    const { actions, logSummary } = buildTagActions({
      statusTagName:       safeTrim(item.tag?.S),
      membershipPlanValue: safeTrim(item.membership_plan?.S),
      secrets
    });

    // Tag key names are non-clinical — safe to log
    console.log("[MAIN] Tag change summary", { patientId, logSummary });

    const updated = await updatePBTags({ token, patientId, actions });

    if (updated) {
      await markComplete(patientId);
      console.log("[MAIN] Sync complete", { patientId, status: SUCCESS_STATUS });
    }
  }

  console.log("[END] Lambda 3 finished");
};
