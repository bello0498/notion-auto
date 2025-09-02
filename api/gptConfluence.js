// ==========================
// api/gptConfluence.js
// ==========================
const fetch = require("node-fetch");

async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_DOMAIN } = process.env;
  if (!CONFLUENCE_EMAIL || !CONFLUENCE_API_TOKEN || !CONFLUENCE_DOMAIN) {
    return res.status(500).json({ error: "Missing Confluence env vars" });
  }

  try {
    const body = await readJSON(req);
    const { title, content, spaceKey } = body || {};

    if (!title || !spaceKey) {
      return res.status(400).json({ error: "Missing 'title' or 'spaceKey'" });
    }

    const response = await fetch(`${CONFLUENCE_DOMAIN}/rest/api/content`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64"),
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "page",
        title: title,
        space: { key: spaceKey },
        body: {
          storage: {
            value: content || "<p>Empty content</p>",
            representation: "storage",
          },
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to save to Confluence", detail: data });
    }

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error("Confluence API error:", err);
    return res.status(500).json({ error: "Unexpected server error", detail: err.message });
  }
};
