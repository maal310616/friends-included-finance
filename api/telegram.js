import { readSupabase, supabase, syncToSheet } from "./records.js";

async function reply(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured in Vercel.");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Bot confirmations remain visible in the chat without creating noisy push
    // notifications during a class demo or a webhook retry.
    body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
  });
  if (!response.ok) throw new Error("Telegram could not send its reply.");
}

async function botUsername() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured in Vercel.");
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = await response.json();
  if (!response.ok || !body.result?.username) throw new Error("Telegram bot profile is unavailable.");
  return body.result.username;
}

const help = [
  "✦ Friends Included Finance bot",
  "",
  "Use /id to get the two numbers Svetlana needs to link your staff role.",
  "Use /sale S01 | Customer | A or B | description | amount | Richard % | Anastasia % | Jean-Claude %",
  "Use /expense E01 | description | Materials, Travel or Other | amount | A, B or overhead",
  "Example:",
  "/sale S01 | Olivia Rose | A | Wedding planning deposit | 1200 | 50 | 30 | 20",
  "/expense E01 | Flowers and decorations | Materials | 250 | A",
  "",
  "Sales wait for Svetlana's approval. Expenses for A or B wait for allocation; overhead is allocated immediately.",
  "Every saved record appears in Supabase and the matching Google Sheet tab.",
].join("\n");

function amountFrom(value) {
  const amount = Number(value?.replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function splitFrom(values) {
  const split = values.map((value) => Number(value?.trim()));
  return split.length === 3 && split.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    && split.reduce((sum, value) => sum + value, 0) === 100 ? split : null;
}

async function referenceExists(reference) {
  const [sales, expenses] = await Promise.all([
    readSupabase(`sales?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`),
    readSupabase(`expenses?select=id&reference=eq.${encodeURIComponent(reference)}&limit=1`),
  ]);
  return Boolean(sales[0] || expenses[0]);
}

async function linkedEmployee(message) {
  const accounts = await readSupabase(`telegram_accounts?select=employee_id,telegram_user_id&telegram_user_id=eq.${encodeURIComponent(message.from.id)}&limit=1`);
  if (!accounts[0]?.employee_id) return null;
  const employees = await readSupabase(`employees?select=id,name,role&id=eq.${accounts[0].employee_id}&limit=1`);
  return employees[0] || null;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      return res.status(200).json({ username: await botUsername() });
    } catch (error) {
      return res.status(503).json({ error: error.message || "Telegram bot profile is unavailable." });
    }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const text = message?.text?.trim();
    if (!chatId || !text) return res.status(200).json({ ok: true });

    if (/^\/start(?:@\w+)?$/i.test(text)) {
      await reply(chatId, "Welcome to Friends Included Finance ✦\n\n" + help);
      return res.status(200).json({ ok: true });
    }
    if (/^\/help(?:@\w+)?$/i.test(text)) {
      await reply(chatId, help);
      return res.status(200).json({ ok: true });
    }
    if (/^\/id(?:@\w+)?$/i.test(text)) {
      await reply(chatId, `Your Telegram user ID: ${message.from?.id}\nYour private chat ID: ${chatId}\n\nAsk Svetlana to link both numbers to your fictional employee in the website manager setup.`);
      return res.status(200).json({ ok: true });
    }

    const sale = text.match(/^\/sale(?:@\w+)?\s+(.+)$/is);
    const expense = text.match(/^\/expense(?:@\w+)?\s+(.+)$/is);
    if (!sale && !expense) {
      await reply(chatId, "I only know /start, /help, /sale, and /expense.\n\n" + help);
      return res.status(200).json({ ok: true });
    }

    const now = new Date().toISOString();
    const employee = await linkedEmployee(message);
    if (!employee) {
      await reply(chatId, "Your Telegram account is not linked to a fictional employee yet. Send /id, then ask Svetlana to link the two numbers in the manager setup.");
      return res.status(200).json({ ok: true });
    }
    let type;
    let record;
    let table;
    if (sale) {
      const parts = sale[1].split("|").map((part) => part.trim());
      let reference, customer, project, description, amountText, percentages;
      // Support the complete assignment format, the earlier labelled short
      // format, and the original short format that creates a TG reference.
      if (parts.length === 8) {
        [reference, customer, project, description, amountText, ...percentages] = parts;
      } else if (parts.length === 5 && /^S\d+$/i.test(parts[0]) && ["A", "B"].includes(parts[2]?.toUpperCase())) {
        [reference, customer, project, amountText, description] = parts;
        percentages = ["50", "30", "20"];
      } else if (parts.length === 4 && ["A", "B"].includes(parts[1]?.toUpperCase())) {
        [customer, project, amountText, description] = parts;
        reference = `TG${message.message_id}`;
        percentages = ["50", "30", "20"];
      } else {
        percentages = [];
      }
      const amount = amountFrom(amountText);
      const proposed = splitFrom(percentages);
      if (!reference || !customer || !["A", "B"].includes(project?.toUpperCase()) || !amount || !description || !proposed) {
        await reply(chatId, "Almost! Use:\n/sale S01 | Customer | A or B | description | amount | Richard % | Anastasia % | Jean-Claude %\nThe three percentages must total 100.");
        return res.status(200).json({ ok: true });
      }
      if (employee.role !== "salesperson") {
        await reply(chatId, `${employee.name} cannot submit a sale. Only the three salespeople can use /sale.`);
        return res.status(200).json({ ok: true });
      }
      type = "sale";
      table = "sales";
      record = { reference, salesperson_id: employee.id, customer, project: project.toUpperCase(), description,
        amount_cents: Math.round(amount * 100), proposed_richard_pct: proposed[0], proposed_anastasia_pct: proposed[1],
        proposed_jean_claude_pct: proposed[2], status: "pending", submitted_via: "telegram",
        originating_telegram_chat_id: chatId, submitted_at: now };
    } else {
      const parts = expense[1].split("|").map((part) => part.trim());
      const assignmentFormat = parts.length === 5;
      const [reference, description, category, amountText, allocationText] = assignmentFormat
        ? parts : [`TG${message.message_id}`, parts[3], parts[0], parts[2], parts[1]];
      const allocation = /^(company )?overhead$/i.test(allocationText || "") ? "Company overhead" : allocationText?.toUpperCase();
      const amount = amountFrom(amountText);
      if (!reference || !['Materials', 'Travel', 'Other'].includes(category) || !['A', 'B', 'Company overhead'].includes(allocation) || !amount || !description) {
        await reply(chatId, "Almost! Use:\n/expense E01 | description | Materials, Travel or Other | amount | A, B or overhead");
        return res.status(200).json({ ok: true });
      }
      if (employee.role !== "expense_reporter") {
        await reply(chatId, `${employee.name} cannot submit an expense. Only Kevin can use /expense.`);
        return res.status(200).json({ ok: true });
      }
      type = "expense";
      table = "expenses";
      record = { reference, reporter_id: employee.id, description, category, amount_cents: Math.round(amount * 100),
        proposed_allocation: allocation, final_allocation: allocation === "Company overhead" ? "Company overhead" : null,
        status: allocation === "Company overhead" ? "allocated" : "awaiting_allocation", submitted_via: "telegram",
        originating_telegram_chat_id: chatId, submitted_at: now };
    }
    if (await referenceExists(record.reference)) {
      await reply(chatId, `Reference ${record.reference} already exists. It was not saved again.`);
      return res.status(200).json({ ok: true });
    }
    const savedResponse = await supabase(table, { method: "POST", body: JSON.stringify(record) });
    const saved = await savedResponse.json();
    if (!savedResponse.ok) throw new Error(saved.message || "Could not save the sale.");

    try {
      await syncToSheet(type, saved[0]);
      const status = type === "sale" ? "is pending approval" : (saved[0].status === "allocated" ? "is allocated to company overhead" : "is awaiting allocation");
      await reply(chatId, `Saved ✦ ${record.reference} ${status} and synced to Google Sheets.`);
    } catch {
      await reply(chatId, `Saved ✦ ${record.reference} was recorded, but Google Sheets needs a retry.`);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    // Telegram retries every non-2xx webhook response. Returning 500 here was
    // the source of repeated error messages for one incoming command. Reply once
    // if possible, then always acknowledge the update so it is never replayed.
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await reply(chatId, "I could not save that record. Nothing was confirmed as submitted—please try again or ask Svetlana to check the website's retry notice.");
    } catch { /* preserve webhook acknowledgement if Telegram delivery also fails */ }
    return res.status(200).json({ ok: true, handledWithError: true });
  }
}
