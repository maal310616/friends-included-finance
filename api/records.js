import crypto from "node:crypto";

const json = (res, status, body) => res.status(status).json(body);
const employeeRole = {
  Richard: "salesperson", Anastasia: "salesperson", "Jean-Claude": "salesperson",
  Kevin: "expense_reporter", Svetlana: "manager",
};

export function supabase(path, options = {}) {
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

export async function readSupabase(path) {
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
  const rawPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
  const privateKey = rawPrivateKey.match(/-----BEGIN PRIVATE KEY-----(?:\\n|\n)?[\s\S]*?-----END PRIVATE KEY-----/)?.[0].replace(/\\n/g, "\n");
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

export async function syncToSheet(type, record) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const token = await googleAccessToken();
  if (!spreadsheetId || !token) return { skipped: true };
  const tab = type === "sale" ? "Sales" : "Expenses";
  const employeeId = type === "sale" ? record.salesperson_id : record.reporter_id;
  const employee = employeeId ? await readSupabase(`employees?select=name&id=eq.${employeeId}&limit=1`) : [];
  const row = type === "sale"
    ? [record.reference, record.submitted_at, employee[0]?.name || "Unknown employee", record.customer, record.project, record.description,
      record.amount_cents / 100, `${record.proposed_richard_pct}/${record.proposed_anastasia_pct}/${record.proposed_jean_claude_pct}`,
      record.approved_richard_pct == null ? "" : `${record.approved_richard_pct}/${record.approved_anastasia_pct}/${record.approved_jean_claude_pct}`,
      record.richard_commission_cents / 100, record.anastasia_commission_cents / 100, record.jean_claude_commission_cents / 100,
      record.status, record.submitted_via]
    : [record.reference, record.submitted_at, employee[0]?.name || "Unknown employee", record.description, record.category, record.amount_cents / 100,
      record.proposed_allocation, record.final_allocation || "", record.status, record.submitted_via];
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const existingResponse = await fetch(`${base}/${encodeURIComponent(`${tab}!A:A`)}`, { headers });
  const existing = await existingResponse.json();
  if (!existingResponse.ok) throw new Error(existing.error?.message || "Could not check the Google Sheet.");
  const rowIndex = (existing.values || []).findIndex((cells) => cells[0] === record.reference);
  const url = rowIndex >= 0
    ? `${base}/${encodeURIComponent(`${tab}!A${rowIndex + 1}:Z${rowIndex + 1}`)}?valueInputOption=USER_ENTERED`
    : `${base}/${encodeURIComponent(`${tab}!A:Z`)}:append?valueInputOption=USER_ENTERED`;
  const response = await fetch(url, {
    method: rowIndex >= 0 ? "PUT" : "POST",
    headers,
    body: JSON.stringify({ values: [row] }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "Could not update Google Sheets.");
  return { updatedRange: body.updatedRange || body.updates?.updatedRange, updated: rowIndex >= 0 };
}

const sheetHeaders = {
  sale: ["Reference", "Submission time", "Salesperson", "Customer", "Project", "Description", "Amount EUR", "Proposed split R A JC", "Approved split R A JC", "Richard commission EUR", "Anastasia commission EUR", "Jean Claude commission EUR", "Status", "Submitted via"],
  expense: ["Reference", "Submission time", "Reporter", "Description", "Category", "Amount EUR", "Proposed allocation", "Final allocation", "Status", "Submitted via"],
};

async function rebuildSheets() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const token = await googleAccessToken();
  if (!spreadsheetId || !token) throw new Error("Google Sheets is not configured.");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values`;
  for (const [type, tab] of [["sale", "Sales"], ["expense", "Expenses"]]) {
    const clear = await fetch(`${base}/${encodeURIComponent(`${tab}!A:Z`)}:clear`, { method: "POST", headers, body: "{}" });
    if (!clear.ok) throw new Error(`Could not clear the ${tab} sheet.`);
    const write = await fetch(`${base}/${encodeURIComponent(`${tab}!A1:Z1`)}?valueInputOption=USER_ENTERED`, { method: "PUT", headers, body: JSON.stringify({ values: [sheetHeaders[type]] }) });
    if (!write.ok) throw new Error(`Could not write ${tab} headings.`);
  }
  const [sales, expenses] = await Promise.all([readSupabase("sales?select=*&order=submitted_at.asc"), readSupabase("expenses?select=*&order=submitted_at.asc")]);
  for (const record of sales) await syncToSheet("sale", record);
  for (const record of expenses) await syncToSheet("expense", record);
  return { sales: sales.length, expenses: expenses.length };
}

function validSplit(record) {
  const values = [record.proposed_richard_pct, record.proposed_anastasia_pct, record.proposed_jean_claude_pct].map(Number);
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) && values.reduce((sum, value) => sum + value, 0) === 100;
}

function commissions(amountCents, shares) {
  const pool = Math.round(amountCents * 0.1);
  const names = ["richard", "anastasia", "jean_claude"];
  const values = shares.map((share) => Math.floor(pool * share / 100));
  let remainder = pool - values.reduce((sum, value) => sum + value, 0);
  const preference = [0, 1, 2];
  preference.sort((left, right) => shares[right] - shares[left] || left - right);
  for (const index of preference) {
    if (!remainder) break;
    values[index] += 1;
    remainder -= 1;
  }
  return { pool, values, names };
}

async function recordByReference(reference) {
  const [sales, expenses] = await Promise.all([
    readSupabase(`sales?select=*&reference=eq.${encodeURIComponent(reference)}`),
    readSupabase(`expenses?select=*&reference=eq.${encodeURIComponent(reference)}`),
  ]);
  if (sales[0]) return { type: "sale", record: sales[0] };
  if (expenses[0]) return { type: "expense", record: expenses[0] };
  return null;
}

async function notify(chatId, text) {
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return { skipped: true };
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error("Telegram delivery failed.");
  return { sent: true };
}

async function linkedChatForEmployee(employeeId) {
  if (!employeeId) return null;
  const accounts = await readSupabase(`telegram_accounts?select=telegram_chat_id&employee_id=eq.${employeeId}&limit=1`);
  return accounts[0]?.telegram_chat_id || null;
}

async function approveSale(record, decision) {
  const shares = [decision.richard_pct, decision.anastasia_pct, decision.jean_claude_pct].map(Number);
  if (shares.some((value) => !Number.isFinite(value) || value < 0 || value > 100) || shares.reduce((sum, value) => sum + value, 0) !== 100) {
    throw new Error("Commission shares must be between 0 and 100 and total exactly 100%.");
  }
  const commission = commissions(record.amount_cents, shares);
  const update = {
    approved_richard_pct: shares[0], approved_anastasia_pct: shares[1], approved_jean_claude_pct: shares[2],
    commission_pool_cents: commission.pool, richard_commission_cents: commission.values[0],
    anastasia_commission_cents: commission.values[1], jean_claude_commission_cents: commission.values[2],
    status: "approved", approved_at: new Date().toISOString(), approved_by: decision.manager_id || null,
  };
  const response = await supabase(`sales?reference=eq.${encodeURIComponent(record.reference)}`, { method: "PATCH", body: JSON.stringify(update) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "Could not approve the sale.");
  let sheetWarning;
  try { await syncToSheet("sale", body[0]); }
  catch (error) { sheetWarning = error.message; }
  const changed = [record.proposed_richard_pct, record.proposed_anastasia_pct, record.proposed_jean_claude_pct].some((value, index) => Number(value) !== shares[index]);
  let notificationWarning;
  try {
    await notify(record.originating_telegram_chat_id, `Sale ${record.reference} approved${changed ? " — commission split changed" : ""}.\nSale €${(record.amount_cents / 100).toFixed(2)}; total commission €${(commission.pool / 100).toFixed(2)}.\nRichard: ${shares[0]}% (€${(commission.values[0] / 100).toFixed(2)})\nAnastasia: ${shares[1]}% (€${(commission.values[1] / 100).toFixed(2)})\nJean-Claude: ${shares[2]}% (€${(commission.values[2] / 100).toFixed(2)})`);
  } catch (error) { notificationWarning = error.message; }
  return { record: body[0], sheetWarning, notificationWarning };
}

async function approveExpense(record, decision) {
  const submittedAllocation = String(decision.allocation || "").trim();
  const allocation = /^company overhead$|^overhead$/i.test(submittedAllocation) ? "Company overhead" : submittedAllocation.toUpperCase();
  if (!["A", "B", "Company overhead"].includes(allocation)) throw new Error("Expense allocation must be A, B, or company overhead.");
  const update = { final_allocation: allocation, status: "allocated", allocated_at: new Date().toISOString(), allocated_by: decision.manager_id || null };
  const response = await supabase(`expenses?reference=eq.${encodeURIComponent(record.reference)}`, { method: "PATCH", body: JSON.stringify(update) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "Could not allocate the expense.");
  let sheetWarning;
  try { await syncToSheet("expense", body[0]); }
  catch (error) { sheetWarning = error.message; }
  let notificationWarning;
  try {
    const changed = record.proposed_allocation !== allocation;
    await notify(record.originating_telegram_chat_id, `Expense ${record.reference} ${changed ? "allocation changed" : "allocated"}.\n€${(record.amount_cents / 100).toFixed(2)}: ${record.description}\nProposed: ${record.proposed_allocation}. Final: ${allocation}.`);
  } catch (error) { notificationWarning = error.message; }
  return { record: body[0], sheetWarning, notificationWarning };
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

    const { action = "submit", type, record, role, decision, reference, employeeId, telegramUserId, chatId } = req.body || {};
    if (action === "linkTelegram") {
      if (role !== "Svetlana" || !employeeId || !telegramUserId || !chatId) return json(res, 403, { error: "Only Svetlana can link a Telegram employee." });
      const existing = await readSupabase(`telegram_accounts?select=id&telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&limit=1`);
      const payload = { employee_id: employeeId, telegram_user_id: String(telegramUserId), telegram_chat_id: String(chatId) };
      const response = await supabase(existing[0] ? `telegram_accounts?id=eq.${existing[0].id}` : "telegram_accounts", { method: existing[0] ? "PATCH" : "POST", body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) return json(res, response.status, { error: body.message || "Could not save the Telegram link." });
      return json(res, 200, body[0]);
    }
    if (action === "approve") {
      if (role !== "Svetlana" || !reference || !decision) return json(res, 403, { error: "Only Svetlana can make manager decisions." });
      const found = await recordByReference(reference);
      if (!found) return json(res, 404, { error: "Record not found." });
      if (found.record.status === "approved") return json(res, 409, { error: "This record is already approved; totals were not changed." });
      const result = found.type === "sale" ? await approveSale(found.record, decision) : await approveExpense(found.record, decision);
      return json(res, 200, result);
    }
    if (action === "retrySync") {
      if (role !== "Svetlana") return json(res, 403, { error: "Only Svetlana can retry a Sheet sync." });
      const found = await recordByReference(reference);
      if (!found) return json(res, 404, { error: "Record not found." });
      return json(res, 200, { ...found.record, sheet: await syncToSheet(found.type, found.record) });
    }
    if (action === "rebuildSheets") {
      if (role !== "Svetlana") return json(res, 403, { error: "Only Svetlana can rebuild the readable Google Sheets copy." });
      return json(res, 200, await rebuildSheets());
    }
    if (!record || !["sale", "expense"].includes(type) || !employeeRole[role]) return json(res, 400, { error: "Invalid request." });
    if ((type === "sale" && employeeRole[role] !== "salesperson") || (type === "expense" && employeeRole[role] !== "expense_reporter")) return json(res, 403, { error: `${role} cannot submit this kind of record.` });
    if (!record.reference || !Number.isInteger(record.amount_cents) || record.amount_cents <= 0) return json(res, 400, { error: "Reference and a positive amount are required." });
    if (type === "sale" && (!record.customer || !["A", "B"].includes(record.project) || !record.description || !validSplit(record))) return json(res, 400, { error: "Sales require customer, A or B, description, and a 100% commission split." });
    if (type === "expense" && (!record.description || !["Materials", "Travel", "Other"].includes(record.category) || !["A", "B", "Company overhead"].includes(record.proposed_allocation))) return json(res, 400, { error: "Expenses require description, category, and allocation." });
    if (await recordByReference(record.reference)) return json(res, 409, { error: "Duplicate reference refused." });
    const table = type === "sale" ? "sales" : "expenses";
    if (!record.originating_telegram_chat_id) record.originating_telegram_chat_id = await linkedChatForEmployee(type === "sale" ? record.salesperson_id : record.reporter_id);
    const response = await supabase(table, { method: "POST", body: JSON.stringify(record) });
    const body = await response.json();
    if (!response.ok) return json(res, response.status, { error: body.message || "Could not save the record." });
    const saved = body[0];
    try { return json(res, 201, { ...saved, sheet: await syncToSheet(type, saved) }); }
    catch (sheetError) { return json(res, 201, { ...saved, sheetWarning: sheetError.message }); }
  } catch (error) {
    return json(res, 500, { error: error.message || "Unexpected server error." });
  }
}
