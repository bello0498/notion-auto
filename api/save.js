// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

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

// ----- 페이지 검색 함수 추가 -----
async function findPageByTitle(notion, databaseId, title) {
  try {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "title", // 또는 실제 title 속성 이름
        title: {
          equals: title
        }
      }
    });
    
    return response.results.length > 0 ? response.results[0].id : null;
  } catch (error) {
    console.error("페이지 검색 오류:", error);
    return null;
  }
}

// ----- handler -----
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!["POST", "GET"].includes(req.method)) {
    return res.status(405).json({ error: "Only POST and GET allowed" });
  }

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID environment variables" });
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // GET 요청: 페이지 목록 조회
    if (req.method === "GET") {
      const { title } = req.query;
      
      if (title) {
        // 특정 타이틀로 페이지 검색
        const pageId = await findPageByTitle(notion, NOTION_DATABASE_ID, title);
        if (pageId) {
          return res.status(200).json({ ok: true, pageId });
        } else {
          return res.status(404).json({ error: "Page not found" });
        }
      } else {
        // 전체 페이지 목록 조회
        const response = await notion.databases.query({
          database_id: NOTION_DATABASE_ID,
          page_size: 50
        });
        
        const pages = response.results.map(page => ({
          id: page.id,
          title: page.properties?.title?.title?.[0]?.text?.content || 
                 page.properties?.Name?.title?.[0]?.text?.content ||
                 page.properties?.제목?.title?.[0]?.text?.content || "제목 없음",
          url: page.url
        }));
        
        return res.status(200).json({ ok: true, pages });
      }
    }

    // POST 요청: 데이터 저장
    const body = await readJSON(req);
    const { mode, title, content, url, date, tags, status, pageId } = body || {};

    if (mode === "db") {
      // 🔹 DB 저장 모드
      if (!title) return res.status(400).json({ error: "Missing 'title' in request body (DB mode)" });

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
    }

    if (mode === "page") {
      // 🔹 Page 저장 모드 - title 검증 제거
      if (!pageId) return res.status(400).json({ error: "Missing 'pageId' in request body (Page mode)" });
      if (!content) return res.status(400).json({ error: "Missing 'content' in request body (Page mode)" });

      const children = toBlocks(content).slice(0, 100);
      await notion.blocks.children.append({
        block_id: pageId,
        children
      });

      return res.status(200).json({ ok: true, pageId });
    }

    if (mode === "find") {
      // 🔹 페이지 찾기 모드 추가
      if (!title) return res.status(400).json({ error: "Missing 'title' in request body (Find mode)" });

      const pageId = await findPageByTitle(notion, NOTION_DATABASE_ID, title);
      if (pageId) {
        return res.status(200).json({ ok: true, pageId });
      } else {
        return res.status(404).json({ error: "Page not found", title });
      }
    }

    return res.status(400).json({ error: "Invalid 'mode'. Use 'db', 'page', or 'find'." });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    const detail = err?.message || err?.response?.data || "Unknown error";
    return res.status(status).json({ error: "Failed to save to Notion", detail });
  }
};