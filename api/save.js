// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

// ---------- helpers ----------
const normalize = (s) => String(s || "").trim().toLowerCase();

// title 자동 매핑 후보 (한국어 포함)
const NAME_CANDIDATES = ["name", "title", "제목", "타이틀"];
const URL_CANDIDATES = ["url", "link", "주소"];
const DATE_CANDIDATES = ["date", "날짜"];
const TAGS_CANDIDATES = ["tags", "tag", "태그"];
const STATUS_CANDIDATES = ["status", "state", "상태"];

// 32자리 id면 UUID 하이픈 추가, 이미 하이픈 있으면 그대로
const toUuid = (id = "") =>
  /^[0-9a-fA-F]{32}$/.test(id)
    ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
    : id;

function toBlocks(raw = "") {
  const lines = String(raw).split("\n").map((l) => l.trimEnd());
  const blocks = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] } });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] } });
    } else if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] } });
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.replace(/^[-*]\s+/, "") } }] }
      });
    } else {
      blocks.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line } }] } });
    }
  }
  if (!blocks.length) blocks.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "" } }] } });
  return blocks.slice(0, 100);
}

async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

function makePropertyMapper(dbProps) {
  const entries = Object.entries(dbProps || {});
  const byType = (t) => entries.filter(([_, v]) => v?.type === t);
  const findByNames = (candidates) => {
    const set = new Set(candidates.map(normalize));
    const found = entries.find(([k]) => set.has(normalize(k)));
    return found ? found[0] : null;
  };

  let titleKey = findByNames(NAME_CANDIDATES) || (byType("title")[0]?.[0] || null);

  const findKey = (cands, type) => {
    const k = findByNames(cands);
    if (k && dbProps[k]?.type === type) return k;
    const list = byType(type);
    return list.length ? list[0][0] : null;
  };

  return {
    titleKey,
    urlKey:    findKey(URL_CANDIDATES, "url"),
    dateKey:   findKey(DATE_CANDIDATES, "date"),
    tagsKey:   findKey(TAGS_CANDIDATES, "multi_select"),
    statusKey: findKey(STATUS_CANDIDATES, "select"),
  };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_PAGE_ID } = process.env;
  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "Missing NOTION_TOKEN environment variable" });
  }

  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);
  const { mode, title, content, url, date, tags, status, pageId } = body || {};

  try {
    // 🔹 PAGE 모드: body.pageId 없으면 env NOTION_PAGE_ID 사용
    if (mode === "page") {
      const target = toUuid(pageId || NOTION_PAGE_ID || "");
      if (!target) return res.status(400).json({ error: "Missing 'pageId' in body or NOTION_PAGE_ID in env (page mode)" });
      if (!content) return res.status(400).json({ error: "Missing 'content' (page mode)" });

      await notion.blocks.children.append({
        block_id: target,
        children: toBlocks(content)
      });

      return res.status(200).json({ ok: true, mode: "page", pageId: target });
    }

    // 🔹 DB 모드: title 필수 + DB ID 필요
    if (mode === "db") {
      const dbId = toUuid(NOTION_DATABASE_ID || "");
      if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID environment variable (db mode)" });
      if (!title) return res.status(400).json({ error: "Missing 'title' (db mode)" });

      const db = await notion.databases.retrieve({ database_id: dbId });
      const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
      if (!titleKey) return res.status(400).json({ error: "No title property in Notion DB" });

      const properties = {};
      properties[titleKey] = { title: [{ type: "text", text: { content: String(title) } }] };
      if (url && urlKey)   properties[urlKey]  = { url: String(url) };
      if (date && dateKey) properties[dateKey] = { date: { start: String(date) } };
      if (Array.isArray(tags) && tags.length && tagsKey) {
        properties[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
      }
      if (status && statusKey) properties[statusKey] = { select: { name: String(status) } };

      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties
      });

      if (content) {
        await notion.blocks.children.append({
          block_id: page.id,
          children: toBlocks(content)
        });
      }

      return res.status(200).json({ ok: true, mode: "db", pageId: page.id });
    }

    return res.status(400).json({ error: "Invalid 'mode'. Use 'db' or 'page'." });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    return res.status(status).json({
      error: "Failed to save to Notion",
      detail: err?.message || err?.response?.data || "Unknown"
    });
  }
};
