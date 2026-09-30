export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "Telegram token is not configured." });
  const host = req.headers.host;
  if (!host) return res.status(500).json({ error: "Could not determine this deployment URL." });
  const webhookUrl = "https://" + host + "/api/telegram";
  const response = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, drop_pending_updates: false }),
  });
  const result = await response.json();
  return res.status(response.ok ? 200 : 500).json({ ok: response.ok, webhookUrl, result });
}
