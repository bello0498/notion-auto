// ==========================
// api/search.js
// ==========================
//
// 🔍 기능: Notion 검색 API (mode에 따라 Page 검색 / DB 검색 분기)
// - mode: "page" → notion.search (워크스페이스 전체 페이지)
// - mode: "db"   → databases.query (특정 DB 속성 기반)
// - 응답: 기본 정보(id, title, url, tags, status, lastEdited 등)
//

const { Client } = require("@notionhq/client");
const { toUuid } = require("../lib/notionUtil");

/** 🔹 요청 바디 JSON 파싱 */
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
  // 🔸 CORS + 메서드 검사
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // 🔸 환경 변수 검사
  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // 🔸 입력 파싱
    const body = await readJSON(req);
    const { query, tags = [], status = null, mode = "page" } = body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'query'" });
    }

    let out = [];

    if (mode === "db") {
      if (!NOTION_DATABASE_ID) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID" });

      // 🔹 DB 검색
      const filters = [{ property: "title", title: { contains: query } }];
      if (Array.isArray(tags) && tags.length) {
        filters.push({
          property: "tags",
          multi_select: { contains: tags[0] }
        });
      }
      if (status) {
        filters.push({ property: "status", select: { equals: status } });
      }

      const result = await notion.databases.query({
        database_id: toUuid(NOTION_DATABASE_ID),
        filter: filters.length === 1 ? filters[0] : { and: filters },
        page_size: 10,
      });

      out = (result?.results || []).map(r => ({
        id: r.id,
        type: "db",
        title: r.properties?.title?.title?.[0]?.plain_text || "(제목 없음)",
        url: r.url,
        tags: r.properties?.tags?.multi_select?.map(t => t.name),
        status: r.properties?.status?.select?.name || null,
        lastEdited: r.last_edited_time
      }));

    } else {
      // 🔹 페이지 검색
      const result = await notion.search({
        query,
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 10
      });

      out = (result?.results || []).map(r => ({
        id: r.id,
        type: r.object, // "page" | "database"
        title: r.properties?.title?.title?.[0]?.plain_text
          || r.properties?.Name?.title?.[0]?.plain_text
          || "(제목 없음)",
        url: r.url,
        lastEdited: r.last_edited_time
      }));
    }

    return res.status(200).json({ ok: true, results: out });

  } catch (err) {
    console.error("Search API error:", err);
    const code = err?.status || err?.response?.status || 500;
    return res.status(code).json({ error: "Search failed", detail: err?.message });
  }
};
