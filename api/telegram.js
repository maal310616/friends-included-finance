import { readSupabase, supabase, syncToSheet } from "./records.js";

async function reply(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured in Vercel.");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error("Telegram could not send its reply.");
}

const help = [
  "✦ Friends Included Finance bot",
  "",
  "Use /id to get the two numbers Svetlana needs to link your staff role.",
  "Use /sale Customer | A or B | amount | description",
  "Use /expense Category | A, B or overhead | amount | description",
  "Example:",
  "/sale Olivia Rose | A | 1200 | Wedding planning deposit",
  "/expense Travel | B | 80 | Taxi for the grandmother",
  "",
  "Sales wait for Svetlana's approval. Expenses for A or B wait for allocation; overhead is allocated immediately.",
  "Every saved record appears in Supabase and the matching Google Sheet tab.",
].join("\n");

function amountFrom(value) {
  const amount = Number(value?.replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

async function linkedEmployee(message) {
  const accounts = await readSupabase(`telegram_accounts?select=employee_id,telegram_user_id,telegram_chat_id&telegram_user_id=eq.${encodeURIComponent(message.from.id)}&limit=1`);
  if (!accounts[0]?.employee_id) return null;
  const employees = await readSupabase(`employees?select=id,name,role&id=eq.${accounts[0].employee_id}&limit=1`);
  return employees[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Friends Included Telegram endpoint");

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
    const reference = `TG${message.message_id}`;
    const employee = await linkedEmployee(message);
    if (!employee) {
      await reply(chatId, "Your Telegram account is not linked to a fictional employee yet. Send /id, then ask Svetlana to link the two numbers in the manager setup.");
      return res.status(200).json({ ok: true });
    }
    let type;
    let record;
    let table;
    if (sale) {
      const [customer, project, amountText, description] = sale[1].split("|").map((part) => part.trim());
      const amount = amountFrom(amountText);
      if (!customer || !["A", "B"].includes(project?.toUpperCase()) || !amount || !description) {
        await reply(chatId, "Almost! Use:\n/sale Customer | A or B | amount | description");
        return res.status(200).json({ ok: true });
      }
      if (employee.role !== "salesperson") {
        await reply(chatId, `${employee.name} cannot submit a sale. Only the three salespeople can use /sale.`);
        return res.status(200).json({ ok: true });
      }
      type = "sale";
      table = "sales";
      record = { reference, salesperson_id: employee.id, customer, project: project.toUpperCase(), description,
        amount_cents: Math.round(amount * 100), proposed_richard_pct: 50, proposed_anastasia_pct: 30,
        proposed_jean_claude_pct: 20, status: "pending", submitted_via: "telegram",
        originating_telegram_chat_id: chatId, submitted_at: now };
    } else {
      const [category, allocationText, amountText, description] = expense[1].split("|").map((part) => part.trim());
      const allocation = allocationText?.toLowerCase() === "overhead" ? "overhead" : allocationText?.toUpperCase();
      const amount = amountFrom(amountText);
      if (!['Materials', 'Travel', 'Other'].includes(category) || !['A', 'B', 'overhead'].includes(allocation) || !amount || !description) {
        await reply(chatId, "Almost! Use:\n/expense Materials, Travel or Other | A, B or overhead | amount | description");
        return res.status(200).json({ ok: true });
      }
      if (employee.role !== "expense_reporter") {
        await reply(chatId, `${employee.name} cannot submit an expense. Only Kevin can use /expense.`);
        return res.status(200).json({ ok: true });
      }
      type = "expense";
      table = "expenses";
      record = { reference, reporter_id: employee.id, description, category, amount_cents: Math.round(amount * 100),
        proposed_allocation: allocation, final_allocation: allocation === "overhead" ? "overhead" : null,
        status: allocation === "overhead" ? "approved" : "awaiting_allocation", submitted_via: "telegram",
        originating_telegram_chat_id: chatId, submitted_at: now };
    }
    const savedResponse = await supabase(table, { method: "POST", body: JSON.stringify(record) });
    const saved = await savedResponse.json();
    if (!savedResponse.ok) throw new Error(saved.message || "Could not save the sale.");

    try {
      await syncToSheet(type, saved[0]);
      const status = type === "sale" ? "is pending approval" : (saved[0].status === "approved" ? "is allocated to company overhead" : "is awaiting allocation");
      await reply(chatId, `Saved ✦ ${reference} ${status} and synced to Google Sheets.`);
    } catch {
      await reply(chatId, `Saved ✦ ${reference} was recorded, but Google Sheets needs a retry.`);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false });
  }
}
