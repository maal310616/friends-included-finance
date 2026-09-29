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

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const [employees, sales, expenses] = await Promise.all([
        supabase("employees?select=id,name,role&order=name").then((r) => r.json()),
        supabase("sales?select=*&order=submitted_at.desc").then((r) => r.json()),
        supabase("expenses?select=*&order=submitted_at.desc").then((r) => r.json()),
      ]);
      return json(res, 200, { employees, sales, expenses });
    }

    const { type, record } = req.body || {};
    if (!record || !["sale", "expense"].includes(type)) return json(res, 400, { error: "Invalid request." });
    const table = type === "sale" ? "sales" : "expenses";
    const response = await supabase(table, { method: "POST", body: JSON.stringify(record) });
    const body = await response.json();
    if (!response.ok) return json(res, response.status, { error: body.message || "Could not save the record." });
    return json(res, 201, body[0]);
  } catch (error) {
    return json(res, 500, { error: error.message || "Unexpected server error." });
  }
}
