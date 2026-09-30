import { readSupabase, supabase, syncToSheet } from "./records.js";

async function reply(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured in Vercel.");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error("Telegram could not send its reply.");
}

const help = [
  "✦ Friends Included Finance bot", "",
  "Use /sale Customer | A or B | amount | description", "Example:",
  "/sale Olivia Rose | A | 1200 | Wedding planning deposit", "",
  "Every sale is saved as pending approval, then appears in Supabase and the Google Sales sheet.",
].join("\n");

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
    const sale = text.match(/^\/sale(?:@\w+)?\s+(.+)$/is);
    if (!sale) {
      await reply(chatId, "I only know /start, /help, and /sale.\n\n" + help);
      return res.status(200).json({ ok: true });
    }
    const [customer, project, amountText, description] = sale[1].split("|").map((part) => part.trim());
    const amount = Number(amountText?.replace(",", "."));
    if (!customer || !["A", "B"].includes(project?.toUpperCase()) || !Number.isFinite(amount) || amount <= 0 || !description) {
      await reply(chatId, "Almost! Use:\n/sale Customer | A or B | amount | description");
      return res.status(200).json({ ok: true });
    }
    const employees = await readSupabase("employees?select=id,name,role&role=eq.salesperson&order=name&limit=1");
    if (!employees[0]) throw new Error("No salesperson is configured in Supabase.");
    const record = {
      reference: `TG${message.message_id}`, salesperson_id: employees[0].id, customer,
      project: project.toUpperCase(), description, amount_cents: Math.round(amount * 100),
      proposed_richard_pct: 50, proposed_anastasia_pct: 30, proposed_jean_claude_pct: 20,
      status: "pending", submitted_via: "telegram", originating_telegram_chat_id: chatId,
      submitted_at: new Date().toISOString(),
    };
    const savedResponse = await supabase("sales", { method: "POST", body: JSON.stringify(record) });
    const saved = await savedResponse.json();
    if (!savedResponse.ok) throw new Error(saved.message || "Could not save the sale.");
    try {
      await syncToSheet("sale", saved[0]);
      await reply(chatId, `Saved ✦ TG${message.message_id} is pending approval and synced to Google Sheets.`);
    } catch {
      await reply(chatId, `Saved ✦ TG${message.message_id} is pending approval. Google Sheets will need a retry.`);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false });
  }
}
