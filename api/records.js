import crypto from "node:crypto";

const json = (res, status, body) => res.status(status).json(body);

function supabase(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase is not configured in Vercel.");
  return fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });
}

async function readSupabase(path) {
  const response = await supabase(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Could not read ${path}.`);
  return body;
}

function googleBase64(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function googleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !privateKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = googleBase64({ alg: "RS256", typ: "JWT" });
  const claims = googleBase64({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).end().sign(privateKey, "base64url");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(token.error_description || "Google Sheets authentication failed.");
  return token.access_token;
}

async function syncToSheet(type, record) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const token = await googleAccessToken();
  if (!spreadsheetId || !token) return { skipped: true };
  const tab = type === "sale" ? "Sales" : "Expenses";
  const row = type === "sale"
    ? [record.reference, record.customer, record.project, record.description, record.amount_cents / 100, record.status, record.submitted_via]
    : [record.reference, record.description, record.category, record.amount_cents / 100, record.proposed_allocation, record.status, record.submitted_via];
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${tab}!A:Z`)}:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "Could not update Google Sheets.");
  return { updatedRange: body.updates?.updatedRange };
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const [employees, sales, expenses] = await Promise.all([
        readSupabase("employees?select=id,name,role&order=name"),
        readSupabase("sales?select=*&order=submitted_at.desc"),
        readSupabase("expenses?select=*&order=submitted_at.desc"),
      ]);
      return json(res, 200, { employees, sales, expenses });
    }

    const { type, record } = req.body || {};
    if (!record || !["sale", "expense"].includes(type)) return json(res, 400, { error: "Invalid request." });
    const table = type === "sale" ? "sales" : "expenses";
    const response = await supabase(table, { method: "POST", body: JSON.stringify(record) });
    const body = await response.json();
    if (!response.ok) return json(res, response.status, { error: body.message || "Could not save the record." });
    const saved = body[0];
    let sheet = { skipped: true };
    try {
      sheet = await syncToSheet(type, saved);
    } catch (sheetError) {
      return json(res, 201, { ...saved, sheetWarning: sheetError.message });
    }
    return json(res, 201, { ...saved, sheet });
  } catch (error) {
    return json(res, 500, { error: error.message || "Unexpected server error." });
  }
}
