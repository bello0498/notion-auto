// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

const normalize = (s) => String(s || "").trim().toLowerCase();

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
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: line.replace(/^[-*]\s+/, "") } }] } });
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN" });

  const body = await readJSON(req);
  const { mode = "db", title, content, url, date, tags, status, pageId } = body || {};

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    if (mode === "page") {
      if (!pageId) return res.status(400).json({ error: "Missing 'pageId' for mode=page" });
      const children = toBlocks(content).slice(0, 100);
      await notion.blocks.children.append({ block_id: pageId, children });
      return res.status(200).json({ ok: true, mode: "page", pageId });
    }

    // ---- mode = db ----
    if (!NOTION_DATABASE_ID) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID" });
    if (!title) return res.status(400).json({ error: "Missing 'title' in request body" });

    const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    const entries = Object.entries(db.properties || {});
    const byType = (t) => entries.filter(([_, v]) => v?.type === t);
    const findKey = (cands, type) => {
      const set = new Set(cands.map(normalize));
      const found = entries.find(([k]) => set.has(normalize(k)));
      if (found && db.properties[found[0]].type === type) return found[0];
      const list = byType(type);
      return list.length ? list[0][0] : null;
    };

    const titleKey = findKey(["name","title","제목"], "title");
    const urlKey = findKey(["url","link","주소"], "url");
    const dateKey = findKey(["date","날짜"], "date");
    const tagsKey = findKey(["tags","tag","태그"], "multi_select");
    const statusKey = findKey(["status","state","상태"], "select");

    const properties = {};
    properties[titleKey] = { title: [{ text: { content: String(title) } }] };
    if (url && urlKey) properties[urlKey] = { url: String(url) };
    if (date && dateKey) properties[dateKey] = { date: { start: String(date) } };
    if (Array.isArray(tags) && tags.length && tagsKey) {
      properties[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
    }
    if (status && statusKey) {
      properties[statusKey] = { select: { name: String(status) } };
    }

    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties
    });

    if (content) {
      const children = toBlocks(content).slice(0, 100);
      if (children.length) {
        await notion.blocks.children.append({ block_id: page.id, children });
      }
    }

    return res.status(200).json({ ok: true, mode: "db", pageId: page.id });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    return res.status(err?.status || 500).json({ error: "Failed", detail: err.message });
  }
};