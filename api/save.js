import { Client } from "@notionhq/client";

// ----- helpers -----
const normalize = (s) => String(s || "").trim().toLowerCase();

const NAME_CANDIDATES = ["name", "title", "제목"];
const URL_CANDIDATES = ["url", "link", "주소"];
const DATE_CANDIDATES = ["date", "날짜"];
const TAGS_CANDIDATES = ["tags", "tag", "태그"];
const STATUS_CANDIDATES = ["status", "state", "상태"];

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
  return blocks;
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

  let titleKey = findByNames(NAME_CANDIDATES);
  if (!titleKey) {
    const titles = byType("title");
    if (titles.length) titleKey = titles[0][0];
  }

  const findKey = (cands, type) => {
    let k = findByNames(cands);
    if (k && dbProps[k]?.type === type) return k;
    const list = byType(type);
    return list.length ? list[0][0] : null;
  };

  const urlKey = findKey(URL_CANDIDATES, "url");
  const dateKey = findKey(DATE_CANDIDATES, "date");
  const tagsKey = findKey(TAGS_CANDIDATES, "multi_select");
  const statusKey = findKey(STATUS_CANDIDATES, "select");

  return { titleKey, urlKey, dateKey, tagsKey, statusKey };
}

// ----- handler -----
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID environment variables" });
  }

  const body = await readJSON(req);
  const { title, content, url, date, tags, status } = body || {};
  if (!title) return res.status(400).json({ error: "Missing 'title' in request body" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
    if (!titleKey) {
      return res.status(400).json({ error: "No title property found in Notion DB. Please add a title property." });
    }

    const properties = {};
    properties[titleKey] = { title: [{ type: "text", text: { content: String(title) } }] };

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
        await notion.blocks.children.append({
          block_id: page.id,
          children
        });
      }
    }

    return res.status(200).json({ ok: true, pageId: page.id });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    const detail = err?.message || err?.response?.data || "Unknown error";
    return res.status(status).json({ error: "Failed to save to Notion", detail });
  }
}
