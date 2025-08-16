// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

// ----- helpers -----
const normalize = (s) => String(s || "").trim().toLowerCase();

// 후보 이름들(한국어 포함)
const NAME_CANDIDATES = ["name", "title", "제목"];
const URL_CANDIDATES = ["url", "link", "주소"];
const DATE_CANDIDATES = ["date", "날짜"];
const TAGS_CANDIDATES = ["tags", "tag", "태그"];
const STATUS_CANDIDATES = ["status", "state", "상태"];

// 간단 마크다운 → Notion 블록
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
  if (req.body && typeof req.body === "object") return req.body; // vercel가 body를 이미 파싱한 경우
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

// DB 속성 자동 매핑
function makePropertyMapper(dbProps) {
  // dbProps: { [propName]: { type, ... } }
  const entries = Object.entries(dbProps || {});
  const byType = (t) => entries.filter(([_, v]) => v?.type === t);
  const findByNames = (candidates) => {
    const set = new Set(candidates.map(normalize));
    const found = entries.find(([k]) => set.has(normalize(k)));
    return found ? found[0] : null;
  };

  // title: 단 하나만 존재 → 자동 탐색 (후보명 우선, 없으면 첫 title)
  let titleKey = findByNames(NAME_CANDIDATES);
  if (!titleKey) {
    const titles = byType("title");
    if (titles.length) titleKey = titles[0][0];
  }

  // url/date/multi_select/select: 후보명 우선, 없으면 타입으로 첫 번째
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
module.exports = async (req, res) => {
  // (옵션) CORS
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
  // 요청 스키마
  // title(필수), content(선택), url(선택), date(선택; YYYY-MM-DD), tags(선택; string[]), status(선택; string)
  const { title, content, url, date, tags, status } = body || {};
  if (!title) return res.status(400).json({ error: "Missing 'title' in request body" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // 1) DB 속성 조회 → 자동 매핑
    const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
    if (!titleKey) {
      return res.status(400).json({ error: "No title property found in Notion DB. Please add a title property." });
    }

    // 2) properties 조립 (존재하는 키만 사용)
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

    // 3) 페이지 생성
    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties
    });

    // 4) 본문 블록 추가
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
};
