// ==========================
// api/save.js
// ==========================

const { Client } = require("@notionhq/client");
const { toBlocks } = require("../lib/toBlocks");
const { normalize, toUuid, deriveTitle, makePropertyMapper } = require("../lib/notionUtil");

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

  const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_PAGE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN env" });

  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);
  const { mode, title, content, url, date, tags, status, pageId: overridePageId } = body || {};
  const m = String(mode || "").trim().toLowerCase();
  if (!m || !["db", "page", "both"].includes(m)) {
    return res.status(400).json({ error: "Missing 'mode' (db | page | both)" });
  }

  const results = {};
  try {
    // 저장 to DB
    if (m === "db" || m === "both") {
      const dbId = toUuid(body?.databaseId || NOTION_DATABASE_ID || "");
      if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env (db/both)" });

      const finalTitle = deriveTitle(title, content);
      const db = await notion.databases.retrieve({ database_id: dbId });
      const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
      if (!titleKey) return res.status(400).json({ error: "No title property in DB" });

      const properties = {};
      properties[titleKey] = { title: [{ type: "text", text: { content: String(finalTitle) } }] };
      if (url && urlKey) properties[urlKey] = { url: String(url) };
      if (date && dateKey) properties[dateKey] = { date: { start: String(date) } };
      if (Array.isArray(tags) && tags.length && tagsKey) {
        properties[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
      }
      if (status && statusKey) {
        properties[statusKey] = { select: { name: String(status) } };
      }

      const dbPage = await notion.pages.create({ parent: { database_id: dbId }, properties });
      if (content) {
        await notion.blocks.children.append({ block_id: dbPage.id, children: toBlocks(content) });
      }
      results.db = dbPage.id;
    }

    // 저장 to 페이지
    if (m === "page" || m === "both") {
      const parentPageId = toUuid(overridePageId || NOTION_PAGE_ID || "");
      if (!parentPageId) return res.status(500).json({ error: "Missing NOTION_PAGE_ID env or pageId in body (page/both)" });

      const finalTitle = deriveTitle(title, content);
      const newPage = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: { title: { title: [{ type: "text", text: { content: String(finalTitle) } }] } },
      });
      if (content) {
        await notion.blocks.children.append({ block_id: newPage.id, children: toBlocks(content) });
      }
      results.page = newPage.id;
    }

    return res.status(200).json({ ok: true, mode: m, results });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const statusCode = err?.status || err?.response?.status || 500;
    return res.status(statusCode).json({
      error: "Failed to save to Notion",
      detail: err?.response?.data || err?.message || "Unknown",
    });
  }
};
