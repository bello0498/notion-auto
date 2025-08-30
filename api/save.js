// api/save.js
import { Client } from "@notionhq/client";

/* ---------- 유틸 ---------- */
// 32자 ID → UUID 하이픈(8-4-4-4-12) 자동 변환
const toUuid = (id = "") =>
  /^[0-9a-fA-F]{32}$/.test(id)
    ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
    : id;

// 간단 마크다운 → Notion 블록(헤딩/불릿/문단)
function toBlocks(raw = "") {
  const lines = String(raw).split("\n").map(l => l.trimEnd());
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

// Vercel에서 body가 객체가 아닐 수도 있어 안전 파싱
async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

// DB 속성 자동 매핑 (제목/URL/날짜/태그/상태 후보명 지원)
const normalize = s => String(s || "").trim().toLowerCase();
const NAME_CANDIDATES = ["name", "title", "제목", "타이틀"];
const URL_CANDIDATES = ["url", "link", "주소"];
const DATE_CANDIDATES = ["date", "날짜"];
const TAGS_CANDIDATES = ["tags", "tag", "태그"];
const STATUS_CANDIDATES = ["status", "state", "상태"];

function makePropertyMapper(dbProps) {
  const entries = Object.entries(dbProps || {});
  const byType = t => entries.filter(([, v]) => v?.type === t);
  const findByNames = cands => {
    const set = new Set(cands.map(normalize));
    const hit = entries.find(([k]) => set.has(normalize(k)));
    return hit ? hit[0] : null;
  };
  let titleKey = findByNames(NAME_CANDIDATES) || (byType("title")[0]?.[0] || null);
  const pick = (cands, type) => {
    const k = findByNames(cands);
    if (k && dbProps[k]?.type === type) return k;
    return byType(type)[0]?.[0] || null;
  };
  return {
    titleKey,
    urlKey:    pick(URL_CANDIDATES, "url"),
    dateKey:   pick(DATE_CANDIDATES, "date"),
    tagsKey:   pick(TAGS_CANDIDATES, "multi_select"),
    statusKey: pick(STATUS_CANDIDATES, "select"),
  };
}

/* ---------- 핸들러 ---------- */
export default async function handler(req, res) {
  // CORS & UTF-8
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_PAGE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN" });

  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);
  const {
    mode,              // "db" | "page"
    title,             // DB 모드에서 필수
    content,           // 저장할 텍스트(마크다운 가능)
    url, date, tags, status, // DB 속성(선택)
    pageId             // 페이지 모드에서 우선 사용 (없으면 env NOTION_PAGE_ID)
  } = body || {};

  try {
    if (mode === "db") {
      const dbId = toUuid(process.env.NOTION_DATABASE_ID);
      if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID" });
      if (!title) return res.status(400).json({ error: "Missing 'title' for DB save" });

      // DB 속성 자동 매핑
      const db = await notion.databases.retrieve({ database_id: dbId });
      const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
      if (!titleKey) return res.status(400).json({ error: "No title property found in Notion DB" });

      const properties = {};
      properties[titleKey] = { title: [{ type: "text", text: { content: String(title) } }] };
      if (url && urlKey)   properties[urlKey]   = { url: String(url) };
      if (date && dateKey) properties[dateKey]  = { date: { start: String(date) } };
      if (Array.isArray(tags) && tags.length && tagsKey) {
        properties[tagsKey] = { multi_select: tags.map(t => ({ name: String(t) })) };
      }
      if (status && statusKey) properties[statusKey] = { select: { name: String(status) } };

      // 새 row 생성
      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties
      });

      // 본문 블록(옵션)
      if (content) {
        await notion.blocks.children.append({
          block_id: page.id,
          children: toBlocks(content)
        });
      }

      return res.status(200).json({ ok: true, mode: "db", pageId: page.id });
    }

    if (mode === "page") {
      const target = toUuid(pageId || NOTION_PAGE_ID || "");
      if (!target) return res.status(400).json({ error: "Missing 'pageId' (or NOTION_PAGE_ID)" });
      if (!content) return res.status(400).json({ error: "Missing 'content' for page append" });

      await notion.blocks.children.append({
        block_id: target,
        children: toBlocks(content)
      });

      return res.status(200).json({ ok: true, mode: "page", pageId: target });
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
}
