// ==========================
// api/search.js
// ==========================
//
// 🔍 기능: Notion 내 특정 쿼리(query)로 페이지 검색
// - 제목(title), URL, 태그(tags), 상태(status) 등 기준으로 검색
// - 응답에서 기본 정보(title, url, pageId, tags 등) 반환
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
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID)
    return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // 🔸 입력 파싱
    const body = await readJSON(req);
    const { query, tags = [], status = null } = body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'query'" });
    }

    // 🔸 검색 필터 정의
    const filters = [
      {
        property: "title",
        title: {
          contains: query
        }
      }
    ];

    if (Array.isArray(tags) && tags.length) {
      filters.push({
        property: "tags",
        multi_select: {
          contains: tags[0]  // 단일 태그만 필터 (간단 버전)
        }
      });
    }

    if (status) {
      filters.push({
        property: "status",
        select: {
          equals: status
        }
      });
    }

    // 🔸 DB 쿼리 실행
    const result = await notion.databases.query({
      database_id: toUuid(NOTION_DATABASE_ID),
      filter: filters.length === 1
        ? filters[0]
        : { and: filters },
      page_size: 10,
    });

    // 🔸 응답 데이터 정리
    const out = (result?.results || []).map((r) => ({
      id: r.id,
      title: r.properties?.title?.title?.[0]?.plain_text || "(제목 없음)",
      url: r.url,
      tags: r.properties?.tags?.multi_select?.map((t) => t.name),
      status: r.properties?.status?.select?.name || null,
    }));

    // 🔸 최종 응답 반환
    return res.status(200).json({ ok: true, results: out });

  } catch (err) {
    console.error("Search API error:", err);
    const code = err?.status || err?.response?.status || 500;
    return res.status(code).json({ error: "Search failed", detail: err?.message });
  }
};
