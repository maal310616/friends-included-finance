export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const host = req.headers.host;
  if (!token || !host) return res.status(500).json({ ok: false, error: "Telegram is not configured." });
  try {
    const webhookUrl = `https://${host}/api/telegram`;
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: webhookUrl }),
    });
    const result = await response.json();
    return res.status(response.ok ? 200 : 502).json({ ok: response.ok, webhookUrl, result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Could not set the webhook." });
  }
}
