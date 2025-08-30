// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

// --- helpers ---
function toBlocks(raw = "") {
  const lines = String(raw).split("\n").map((l) => l.trimEnd());
  const blocks = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: [{ text: { content: line.slice(4) } }] } });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: [{ text: { content: line.slice(3) } }] } });
    } else if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: [{ text: { content: line.slice(2) } }] } });
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ text: { content: line.replace(/^[-*]\s+/, "") } }] }
      });
    } else {
      blocks.push({ type: "paragraph", paragraph: { rich_text: [{ text: { content: line } }] } });
    }
  }
  return blocks.length ? blocks : [{ type: "paragraph", paragraph: { rich_text: [{ text: { content: "" } }] } }];
}

async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

// --- handler ---
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "Missing NOTION_TOKEN env variable" });
  }

  const body = await readJSON(req);
  const { mode, title, content, pageId } = body || {};
  if (!mode) return res.status(400).json({ error: "Missing 'mode' in request body" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    if (mode === "db") {
      if (!NOTION_DATABASE_ID) {
        return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env variable" });
      }
      if (!title) {
        return res.status(400).json({ error: "Missing 'title' for db mode" });
      }

      const page = await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: String(title) } }] }
        }
      });

      if (content) {
        const children = toBlocks(content).slice(0, 100);
        await notion.blocks.children.append({
          block_id: page.id,
          children
        });
      }

      return res.status(200).json({ ok: true, pageId: page.id });
    }

    if (mode === "page") {
      if (!pageId) {
        return res.status(400).json({ error: "Missing 'pageId' for page mode" });
      }

      const children = toBlocks(content || "").slice(0, 100);
      await notion.blocks.children.append({
        block_id: pageId,
        children
      });

      return res.status(200).json({ ok: true, pageId });
    }

    return res.status(400).json({ error: "Invalid mode, use 'db' or 'page'" });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    return res.status(status).json({ error: "Failed to save to Notion", detail: err?.message });
  }
};
