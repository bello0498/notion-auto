// ==========================
// api/confluence/search.js
// ==========================
//
// 🔍 기능: Confluence 페이지 키워드 검색
// - 제목(title)에 query 문자열이 포함된 페이지를 반환
// - DB가 아니라 Confluence 전체를 대상으로 CQL 검색 실행
// - 결과: id, title, url, lastUpdated
//

import fetch from "node-fetch";

/** 🔹 요청 바디 파서 */
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

/** 🔹 메인 핸들러 */
export default async function handler(req, res) {
  // CORS & 헤더 설정
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");

  if (req.method === "OPTIONS") return res.status(200).end(); // Preflight 처리
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // 환경변수 확인
  const { CONFLUENCE_BASE_URL, CONFLUENCE_API_TOKEN, CONFLUENCE_EMAIL } = process.env;
  if (!CONFLUENCE_BASE_URL || !CONFLUENCE_API_TOKEN || !CONFLUENCE_EMAIL) {
    return res.status(500).json({ error: "Missing Confluence environment variables" });
  }

  try {
    // 요청 바디 파싱
    const body = await readJSON(req);
    const { query } = body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'query'" });
    }

    // 🔹 Confluence CQL 검색 (제목에 query 포함)
    const resp = await fetch(
      `${CONFLUENCE_BASE_URL}/rest/api/content/search?cql=title~"${encodeURIComponent(query)}"&limit=10`,
      {
        headers: {
          "Authorization": `Basic ${Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64")}`,
          "Accept": "application/json"
        }
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Confluence search failed: ${resp.status} ${text}`);
    }

    // 응답 데이터 가공
    const data = await resp.json();
    const results = (data.results || []).map(p => ({
      id: p.id,
      title: p.title,
      url: `${CONFLUENCE_BASE_URL}${p._links?.webui}`,
      lastUpdated: p.version?.when
    }));

    // 최종 응답
    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Confluence Search API error:", err);
    return res.status(500).json({ error: "Search failed", detail: err.message });
  }
}
