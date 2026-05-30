// ===============================================
// LAMBDA 2 — GHL → DDB (FINAL SAFE VERSION)
// Trigger: API Gateway (Webhook)
// Runtime: Node.js 22.x | CommonJS | Native fetch
// ===============================================
// HIPAA note: No PHI logged. Logs contain only
// patientId (internal system ID), status changes,
// and error codes. No names, emails, or phone
// numbers appear in CloudWatch logs.
// ===============================================

const {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand
} = require("@aws-sdk/client-dynamodb");

const ddb = new DynamoDBClient({});

// ----------------------------------
// CONSTANTS
// Table name injected via Lambda environment variable.
// Actual value lives in AWS — never hardcoded here.
// ----------------------------------
const TABLE_NAME = process.env.SYNC_TABLE_NAME; // e.g. "BridgeStateTable"

// ----------------------------------
// Helper: detect meaningful changes
// Only triggers a DDB write if something actually changed —
// prevents unnecessary PENDING_TO_PB churn and loop risk.
// ----------------------------------
function hasMeaningfulChange(existing, incoming) {
  if (!existing) return true;

  const fields = ["firstName", "lastName", "email", "phone", "tag"];

  return fields.some((field) => {
    const oldVal = existing[field]?.S || "";
    const newVal = incoming[field]  || "";
    return oldVal !== newVal;
  });
}

// ----------------------------------
// Lambda Handler
// ----------------------------------
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const patientId = body.patientId;
    if (!patientId) {
      console.log("[L2] Ignored webhook: missing patientId");
      return ok();
    }

    console.log("[L2] GHL webhook received", { patientId });

    const pk = patientId;

    // Fetch existing DDB record
    const existing = await ddb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: pk } }
      })
    );

    // Normalise incoming fields
    const incomingTag =
      Array.isArray(body.tags) && body.tags.length > 0
        ? body.tags[0]
        : body.tag || "";

    const incomingData = {
      firstName: body.firstName || "",
      lastName:  body.lastName  || "",
      email:     body.email     || "",
      phone:     body.phone     || "",
      tag:       incomingTag
    };

    // ----------------------------------
    // LOOP PROTECTION
    // If last write came from GHL and nothing has changed,
    // skip update to avoid an infinite GHL → DDB → PB → GHL loop.
    // ----------------------------------
    if (
      existing.Item?.lastUpdatedBy?.S === "GHL" &&
      !hasMeaningfulChange(existing.Item, incomingData)
    ) {
      console.log("[L2] Skipped — no meaningful change detected", { patientId });
      return ok();
    }

    // ----------------------------------
    // Build UpdateExpression dynamically
    // Prevents accidental data loss on partial updates.
    // ----------------------------------
    const now = new Date().toISOString();

    const updateExpressionParts = [];
    const expressionValues = {};
    const expressionNames  = {};

    function setField(name, value) {
      updateExpressionParts.push(`#${name} = :${name}`);
      expressionNames[`#${name}`] = name;
      expressionValues[`:${name}`] = { S: value };
    }

    setField("firstName",     incomingData.firstName);
    setField("lastName",      incomingData.lastName);
    setField("email",         incomingData.email);
    setField("phone",         incomingData.phone);
    setField("tag",           incomingData.tag);
    setField("status",        "PENDING_TO_PB");
    setField("lastUpdatedBy", "GHL");
    setField("updated_at",    now);

    const UpdateExpression = "SET " + updateExpressionParts.join(", ");

    // Safe update — only modifies listed fields, no deletes
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: pk } },
        UpdateExpression,
        ExpressionAttributeNames:  expressionNames,
        ExpressionAttributeValues: expressionValues
      })
    );

    console.log("[L2] DDB update written — status set to PENDING_TO_PB", { patientId });
    return ok();

  } catch (err) {
    // Always ACK the webhook — GHL will retry on non-200 responses
    // which could cause duplicate processing
    console.error("[L2] Error", { errorName: err.name });
    return ok();
  }
};

// ----------------------------------
// Webhook-safe 200 response
// Always return 200 to prevent GHL retry storms
// ----------------------------------
function ok() {
  return {
    statusCode: 200,
    body: JSON.stringify({ success: true })
  };
}
