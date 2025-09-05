// ==========================
// 📘 Confluence 페이지 생성 API (최종)
// ==========================
//
// - 제목(title)과 본문(content)을 분리하여 받음
// - content에 title이 중복 포함되어 있을 경우 자동 제거
// - 지정된 spaceKey 내에 페이지 생성
// - (선택) parentPageId로 하위 페이지로 생성 가능
// - 생성된 Confluence 페이지의 URL을 함께 반환

const fetch = require("node-fetch");

// 📥 요청 바디 JSON 파싱
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

// 🔧 /wiki 경로 보정 처리 (마지막 슬래시 제거 등)
function normalizeWikiDomain(domain) {
  if (!domain) return "";
  const base = domain.replace(/\/+\$/, "");
  return base.endsWith("/wiki") ? base : base + "/wiki";
}

// 🔧 content에 포함된 제목 제거 처리 (Markdown 또는 HTML 기반)
function removeTitleFromContent(title, content) {
  const lines = content.split("\n").map((line) => line.trim());
  const firstLine = lines[0].replace(/^#+\s*|<h[1-6]>|<\/h[1-6]>/gi, "").trim();
  return firstLine === title.trim() ? lines.slice(1).join("\n").trim() : content;
}

// ✅ 메인 API 엔드포인트
module.exports = async (req, res) => {
  // 📋 공통 헤더 처리
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // 🔐 환경 변수 확인
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
      parentPageId: bodyParentPageId
    } = body || {};

    const safeTitle = (title || "").toString().trim();
    if (!safeTitle) {
      return res.status(400).json({ error: "Missing 'title'" });
    }

    // 🧹 content에서 제목 제거
    const cleanedContent = removeTitleFromContent(safeTitle, content);

    const parentPageId = (bodyParentPageId || CONFLUENCE_PARENT_PAGE_ID || "").toString().trim();

    // 📤 전송할 페이로드 구성
    const payload = {
      type: "page",
      title: safeTitle,
      space: { key: CONFLUENCE_SPACE_KEY },
      ...(parentPageId ? { ancestors: [{ id: parentPageId }] } : {}),
      body: {
        storage: {
          value: cleanedContent || "<p>Empty content</p>",
          representation: "storage"
        }
      }
    };

    // 🌐 Confluence API 호출
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64"),
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    // ⚠️ 오류 처리
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to save to Confluence",
        detail: data,
        used: {
          endpoint,
          spaceKey: CONFLUENCE_SPACE_KEY,
          parentPageId: parentPageId || null
        }
      });
    }

    // 🔗 생성된 페이지 링크 구성
    const baseLink = (data && data._links && data._links.base) || wikiBase.replace(/\/wiki$/, "");
    const webui = data && data._links && data._links.webui;
    const pageUrl = baseLink && webui ? baseLink + webui : null;

    // 🎉 성공 응답
    return res.status(200).json({ ok: true, id: data.id, links: { webui: pageUrl } });
  } catch (err) {
    console.error("Confluence API error:", err);
    return res.status(500).json({ error: "Unexpected server error", detail: err.message });
  }
};