// ==========================
// 📘 Confluence 페이지 생성 API (최종)
// ==========================
//
// - 제목(title)과 본문(content)을 분리하여 받음
// - content에 title이 중복 포함되어 있을 경우 자동 제거
// - 지정된 spaceKey 내에 페이지 생성
// - (선택) parentPageId 또는 parentTitle로 하위 페이지 생성 가능
// - 생성된 Confluence 페이지의 URL을 함께 반환

const fetch = require("node-fetch");

// ==========================
// 📥 요청 바디 JSON 파싱 함수
// ==========================
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

// ==========================
// 🔧 /wiki 경로 보정 처리
// ==========================
function normalizeWikiDomain(domain) {
  if (!domain) return "";
  const base = domain.replace(/\/+\$/, "");
  return base.endsWith("/wiki") ? base : base + "/wiki";
}

// ==========================
// 🔧 content에 포함된 제목 제거 처리
// ==========================
// - Markdown 헤더 또는 HTML <h*> 태그 기반 정제
function removeTitleFromContent(title, content) {
  const lines = content.split("\n").map((line) => line.trim());
  const firstLine = lines[0].replace(/^#+\s*|<h[1-6]>|<\/h[1-6]>/gi, "").trim();
  return firstLine === title.trim() ? lines.slice(1).join("\n").trim() : content;
}

// ==========================
// 🔍 parentTitle로 Confluence 페이지 ID 검색 함수
// ==========================
async function getParentPageIdFromTitle(title, wikiBase, email, token, spaceKey) {
  const query = encodeURIComponent(`type=page AND space="${spaceKey}" AND title="${title}"`);
  const url = `${wikiBase}/rest/api/content/search?cql=${query}`;

  const res = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
      Accept: "application/json",
    },
  });

  const data = await res.json();
  const page = data.results?.[0];
  return page?.id || null;
}

// ==========================
// ✅ 메인 API 엔드포인트
// ==========================
module.exports = async (req, res) => {
  // 📋 공통 응답 헤더 설정
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // 🔐 필수 환경 변수 확인
  const {
    CONFLUENCE_EMAIL,
    CONFLUENCE_API_TOKEN,
    CONFLUENCE_DOMAIN,
    CONFLUENCE_SPACE_KEY,
    CONFLUENCE_PARENT_PAGE_ID,
  } = process.env;

  if (!CONFLUENCE_EMAIL || !CONFLUENCE_API_TOKEN || !CONFLUENCE_DOMAIN) {
    return res.status(500).json({ error: "Missing Confluence env vars" });
  }
  if (!CONFLUENCE_SPACE_KEY) {
    return res.status(500).json({ error: "Missing CONFLUENCE_SPACE_KEY (spaceKey required)" });
  }

  const wikiBase = normalizeWikiDomain(CONFLUENCE_DOMAIN);
  const endpoint = `${wikiBase}/rest/api/content`;

  try {
    // 📦 요청 바디 파싱
    const body = await readJSON(req);
    const {
      title,
      content,
      parentPageId: bodyParentPageId,
      parentTitle,
    } = body || {};

    // 📛 제목 필수 확인
    const safeTitle = (title || "").toString().trim();
    if (!safeTitle) {
      return res.status(400).json({ error: "Missing 'title'" });
    }

    // 🧹 content에서 title 중복 제거
    const cleanedContent = removeTitleFromContent(safeTitle, content);

    // 🔍 부모 페이지 ID 우선순위 처리 (요청값 > ENV > title 검색)
    let parentPageId = (bodyParentPageId || CONFLUENCE_PARENT_PAGE_ID || "").toString().trim();
    if (!parentPageId && parentTitle) {
      parentPageId = await getParentPageIdFromTitle(
        parentTitle,
        wikiBase,
        CONFLUENCE_EMAIL,
        CONFLUENCE_API_TOKEN,
        CONFLUENCE_SPACE_KEY
      );
    }

    // 🧾 최종 요청 페이로드 구성
    // - title: 페이지 제목
    // - space: 저장할 공간 key
    // - ancestors: (선택) 부모 페이지 ID 배열 → 하위 페이지 생성
    // - body.storage: HTML 기반 콘텐츠 저장 영역
    const payload = {
      type: "page",
      title: safeTitle,
      space: { key: CONFLUENCE_SPACE_KEY },
      ...(parentPageId ? { ancestors: [{ id: parentPageId }] } : {}),
      body: {
        storage: {
          value: cleanedContent || "<p>Empty content</p>",
          representation: "storage",
        },
      },
    };

    // 🌐 Confluence API 호출
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64"),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // ⚠️ 실패 처리
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to save to Confluence",
        detail: data,
        used: {
          endpoint,
          spaceKey: CONFLUENCE_SPACE_KEY,
          parentPageId: parentPageId || null,
        },
      });
    }

    // 🔗 생성된 페이지 링크 반환
    const baseLink = (data && data._links && data._links.base) || wikiBase.replace(/\/wiki$/, "");
    const webui = data && data._links && data._links.webui;
    const pageUrl = baseLink && webui ? baseLink + webui : null;

    // 🎉 최종 성공 응답 반환
    return res.status(200).json({ ok: true, id: data.id, links: { webui: pageUrl } });
  } catch (err) {
    console.error("Confluence API error:", err);
    return res.status(500).json({ error: "Unexpected server error", detail: err.message });
  }
};
