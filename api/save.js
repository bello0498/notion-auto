// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

// ---------- helpers ----------
const normalize = (s) => String(s || "").trim().toLowerCase();
const stripSpaces = (s) => normalize(s).replace(/\s+/g, "");
const toUuid = (id = "") =>
  /^[0-9a-fA-F]{32}$/.test(id)
    ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
    : id;

// 제목 자동 생성: 입력 title > content 첫 줄 > 시간기반 기본값
function deriveTitle(title, content) {
  const t = String(title || "").trim();
  if (t) return t;
  const firstLine = String(content || "")
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0) || "";
  if (firstLine) return firstLine.replace(/^#+\s*|^[-*]\s*/,'').slice(0, 80);
  const d = new Date();
  const pad = (n)=>String(n).padStart(2,'0');
  return `Auto Note ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Markdown-ish -> Notion blocks
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
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.replace(/^[-*]\s+/, "") } }] } });
    } else {
      blocks.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line } }] } });
    }
  }
  return blocks.length ? blocks.slice(0, 100) : [{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "" } }] } }];
}

async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

// DB 속성 자동 매핑 (키 + 타입 + 옵션까지 반환)
function makePropertyMapper(dbProps) {
  const entries = Object.entries(dbProps || {});
  const byType = (t) => entries.filter(([_, v]) => v?.type === t);
  const findByNames = (cands) => {
    const set = new Set(cands.map(normalize));
    const found = entries.find(([k]) => set.has(normalize(k)));
    return found ? found[0] : null;
  };

  const NAME_CANDS   = ["name", "title", "제목", "타이틀"];
  const URL_CANDS    = ["url", "link", "주소"];
  const DATE_CANDS   = ["date", "날짜"];
  const TAGS_CANDS   = ["tags", "tag", "태그"];
  const STATUS_CANDS = ["status", "state", "상태"];

  const titleKey  = findByNames(NAME_CANDS)   || (byType("title")[0]?.[0] || null);
  const urlKey    = findByNames(URL_CANDS)    || (byType("url")[0]?.[0] || null);
  const dateKey   = findByNames(DATE_CANDS)   || (byType("date")[0]?.[0] || null);
  const tagsKey   = findByNames(TAGS_CANDS)   || (byType("multi_select")[0]?.[0] || null);

  // status 우선순위: 이름 매칭 > 타입(status) > 타입(select)
  let statusKey = findByNames(STATUS_CANDS);
  let statusType = null;
  if (statusKey) {
    statusType = dbProps[statusKey]?.type || null;
  } else {
    const st = byType("status")[0];
    const sel = byType("select")[0];
    if (st) { statusKey = st[0]; statusType = "status"; }
    else if (sel) { statusKey = sel[0]; statusType = "select"; }
  }

  const shape = (key) => key ? { key, type: dbProps[key]?.type || null } : { key: null, type: null };
  const statusInfo = statusKey ? {
    key: statusKey,
    type: statusType || (dbProps[statusKey]?.type || null),
    options: (() => {
      const def = dbProps[statusKey];
      if (!def) return [];
      if (def.type === "status") return (def.status?.options || []).map(o => o?.name).filter(Boolean);
      if (def.type === "select") return (def.select?.options || []).map(o => o?.name).filter(Boolean);
      return [];
    })()
  } : { key: null, type: null, options: [] };

  return {
    title:  shape(titleKey),
    url:    shape(urlKey),
    date:   shape(dateKey),
    tags:   shape(tagsKey),
    status: statusInfo
  };
}

// 상태값 이름을 옵션과 매칭 (대소문자/공백 무시)
function matchOptionName(inputName, options = []) {
  if (!inputName) return null;
  const inNorm = stripSpaces(inputName);
  const found = options.find(opt => stripSpaces(opt) === inNorm);
  return found || null;
}

// ---------- handler ----------
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    // -------- DB 저장 (db / both) --------
    if (m === "db" || m === "both") {
      const dbId = toUuid(body?.databaseId || NOTION_DATABASE_ID || "");
      if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env (db/both)" });

      const finalTitle = deriveTitle(title, content);
      const db = await notion.databases.retrieve({ database_id: dbId });
      const propsMap = makePropertyMapper(db?.properties || {});
      if (!propsMap.title?.key) return res.status(400).json({ error: "No title property in DB" });

      const properties = {};
      // title
      properties[propsMap.title.key] = { title: [{ type: "text", text: { content: String(finalTitle) } }] };
      // url
      if (url && propsMap.url?.key) {
        properties[propsMap.url.key] = { url: String(url) };
      }
      // date
      if (date && propsMap.date?.key) {
        properties[propsMap.date.key] = { date: { start: String(date) } };
      }
      // tags (multi_select)
      if (Array.isArray(tags) && tags.length && propsMap.tags?.key && propsMap.tags.type === "multi_select") {
        properties[propsMap.tags.key] = { multi_select: tags.map(t => ({ name: String(t) })) };
      }
      // status: 지원 (status 타입 또는 select 타입)
      if (status && propsMap.status?.key) {
        const sVal = String(status);
        if (propsMap.status.type === "status") {
          const matched = matchOptionName(sVal, propsMap.status.options);
          if (!matched) {
            // 허용 가능한 값 안내 (사전 검증)
            return res.status(400).json({
              error: "Invalid status value",
              detail: `Status 옵션에 '${sVal}' 이(가) 없습니다.`,
              allowed: propsMap.status.options
            });
          }
          properties[propsMap.status.key] = { status: { name: matched } };
        } else if (propsMap.status.type === "select") {
          properties[propsMap.status.key] = { select: { name: sVal } }; // select는 새 옵션 생성 가능
        } else {
          // 기타 타입이면 무시
        }
      }

      const dbPage = await notion.pages.create({ parent: { database_id: dbId }, properties });
      if (content) {
        await notion.blocks.children.append({ block_id: dbPage.id, children: toBlocks(content) });
      }
      results.db = dbPage.id;
    }

    // -------- 하위 페이지 생성 + 블록 추가 (page / both) --------
    if (m === "page" || m === "both") {
      const parentPageId = toUuid(overridePageId || NOTION_PAGE_ID || "");
      if (!parentPageId) return res.status(500).json({ error: "Missing NOTION_PAGE_ID env or pageId in body (page/both)" });

      const finalTitle = deriveTitle(title, content);
      const newPage = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ type: "text", text: { content: String(finalTitle) } }] }
        }
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
      detail: err?.response?.data || err?.message || "Unknown"
    });
  }
};
