// ==========================
// 📘 Confluence 페이지 Save API (Upsert: Create + Update)
// ==========================
//
// - 제목(title)과 본문(content)을 분리하여 받음
// - content에 title이 중복 포함되어 있을 경우 자동 제거
// - 지정된 spaceKey 내에 페이지 생성
// - (선택) parentPageId 또는 parentTitle로 하위 페이지 생성 가능
// - scope="parent" → 상위 페이지 수정
// - scope="child"  → 하위 페이지 중 title 일치하는 것 수정
// - 동일 제목 페이지 존재 시 update, 없으면 create
//

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
function removeTitleFromContent(title, content) {
  if (!content) return "";
  const lines = content.split("\n").map((line) => line.trim());
  const firstLine = lines[0].replace(/^#+\s*|<h[1-6]>|<\/h[1-6]>/gi, "").trim();
  return firstLine === title.trim() ? lines.slice(1).join("\n").trim() : content;
}

// ==========================
// 🔍 parentTitle로 Confluence 페이지 ID 검색
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
// 🔍 제목으로 Confluence 페이지 검색 (정확 매칭)
// ==========================
async function findPageByTitle(title, wikiBase, email, token, spaceKey) {
  const query = encodeURIComponent(`type=page AND space="${spaceKey}" AND title="${title}"`);
  const url = `${wikiBase}/rest/api/content/search?cql=${query}`;

  const res = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
      Accept: "application/json",
    },
  });

  const data = await res.json();
  return data.results?.[0] || null;
}

// ==========================
// 🔍 하위 페이지 목록 불러오기
// ==========================
async function getChildPages(parentId, wikiBase, email, token) {
  const url = `${wikiBase}/rest/api/content/${parentId}/child/page?limit=50`;

  const res = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
      Accept: "application/json",
    },
  });

  const data = await res.json();
  return data.results || [];
}

// ==========================
// ✅ 메인 API 엔드포인트
// ==========================
module.exports = async (req, res) => {
  // 📋 공통 응답 헤더
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // 🔐 환경 변수
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
    // 📦 요청 바디
    const body = await readJSON(req);
    const {
      title,
      content,
      parentPageId: bodyParentPageId,
      parentTitle,
      scope = "parent", // 기본 parent 수정
      childTitle,
    } = body || {};

    // 📛 제목 필수
    const safeTitle = (title || "").toString().trim();
    if (!safeTitle) {
      return res.status(400).json({ error: "Missing 'title'" });
    }

    // 🧹 content 정리 (타이틀 중복 제거)
    const cleanedContent = removeTitleFromContent(safeTitle, content);

    // 🔍 부모 ID 처리
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

    // ==========================
    // ✏️ Upsert 로직
    // ==========================
    let targetPage = await findPageByTitle(safeTitle, wikiBase, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_SPACE_KEY);

    if (scope === "child" && parentPageId && childTitle) {
      // 🔍 child 수정 모드
      const children = await getChildPages(parentPageId, wikiBase, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN);
      targetPage = children.find(c => c.title === childTitle);
    }

    if (targetPage) {
      // 기존 페이지 있으면 UPDATE
      const updateUrl = `${wikiBase}/rest/api/content/${targetPage.id}`;
      const response = await fetch(updateUrl, {
        method: "PUT",
        headers: {
          Authorization: "Basic " + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64"),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          id: targetPage.id,
          type: "page",
          title: scope === "child" ? childTitle : safeTitle,
          space: { key: CONFLUENCE_SPACE_KEY },
          body: {
            storage: {
              value: cleanedContent || "<p>Empty content</p>",
              representation: "storage",
            },
          },
          version: { number: (targetPage.version?.number || 0) + 1 },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: "Failed to update Confluence", detail: data });
      }

      const pageUrl = `${wikiBase.replace(/\/wiki$/, "")}${data._links.webui}`;
      return res.status(200).json({ ok: true, updated: true, id: data.id, links: { webui: pageUrl } });
    } else {
      // 없으면 CREATE
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
      if (!response.ok) {
        return res.status(response.status).json({ error: "Failed to create Confluence page", detail: data });
      }

      const pageUrl = `${wikiBase.replace(/\/wiki$/, "")}${data._links.webui}`;
      return res.status(200).json({ ok: true, updated: false, id: data.id, links: { webui: pageUrl } });
    }
  } catch (err) {
    console.error("Confluence Save/Update API error:", err);
    return res.status(500).json({ error: "Unexpected server error", detail: err.message });
  }
};
