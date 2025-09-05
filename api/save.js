// ==========================
// api/save.js (최종 버전)
// ==========================

const { Client } = require("@notionhq/client");
const { toBlocks } = require("../lib/toBlocks");
const { toUuid, deriveTitle, makePropertyMapper } = require("../lib/notionUtil");

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

function removeTitleFromContent(title, content) {
  const lines = content.split("\n").map(l => l.trim());
  if (lines[0].replace(/^#+\s*/, "") === title.trim()) {
    return lines.slice(1).join("\n");
  }
  return content;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN env" });

  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);
  const { title, content, url, date, tags, status, pageId, databaseId, summary } = body || {};
  const results = {};

  try {
    const dbId = toUuid(databaseId || NOTION_DATABASE_ID || "");
    if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env" });

    const finalTitle = deriveTitle(title, content);
    const db = await notion.databases.retrieve({ database_id: dbId });
    const {
      titleKey, urlKey, dateKey, tagsKey, statusKey, pageIdKey, pageUrlKey
    } = makePropertyMapper(db?.properties || {});
    if (!titleKey) return res.status(400).json({ error: "No title property in DB" });

    let newPageId = pageId;
    const isUpdate = !!pageId;

    if (!newPageId) {
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
      newPageId = dbPage.id;

      const pageUrl = `https://www.notion.so/${newPageId.replace(/-/g, "")}`;
      const updateProps = {};
      if (pageIdKey) updateProps[pageIdKey] = { rich_text: [{ text: { content: newPageId } }] };
      if (pageUrlKey) updateProps[pageUrlKey] = { url: pageUrl };
      if (Object.keys(updateProps).length) {
        await notion.pages.update({ page_id: newPageId, properties: updateProps });
      }

      results.db = newPageId;
      results.url = pageUrl;
    } else {
      results.db = newPageId;
      results.url = `https://www.notion.so/${newPageId.replace(/-/g, "")}`;
    }

    if (content && newPageId) {
      const cleaned = removeTitleFromContent(finalTitle, content);
      const blocks = toBlocks(cleaned);

      const oldBlocks = await notion.blocks.children.list({ block_id: newPageId });
      for (const block of oldBlocks.results) {
        await notion.blocks.delete({ block_id: block.id });
      }
      await notion.blocks.children.append({ block_id: newPageId, children: blocks });
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const statusCode = err?.status || err?.response?.status || 500;
    return res.status(statusCode).json({
      error: "Failed to save to Notion",
      detail: err?.response?.data || err?.message || "Unknown",
    });
  }
};
