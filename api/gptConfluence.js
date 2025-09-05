// ==========================
// api/gptConfluence.js
// ==========================
const fetch = require("node-fetch");

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

// /wiki 보정
function normalizeWikiDomain(domain) {
  if (!domain) return "";
  const base = domain.replace(/\/+$/, "");
  return base.endsWith("/wiki") ? base : base + "/wiki";
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const {
    CONFLUENCE_EMAIL,
    CONFLUENCE_API_TOKEN,
    CONFLUENCE_DOMAIN,         // 예: https://aegisep.atlassian.net/wiki  (뒤에 /wiki 붙는지 상관없음)
    CONFLUENCE_SPACE_KEY,      // ★ 필수: 이 스페이스 키로만 생성
    CONFLUENCE_PARENT_PAGE_ID, // (선택) 기본 부모 페이지 ID — 있으면 하위페이지로 생성
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
    const body = await readJSON(req);
    const {
      title,
      content,
      parentPageId: bodyParentPageId, // (선택) 요청 시 이 값이 있으면 ENV보다 우선
      // ⚠️ 아래 값들은 무시(강제로 spaceKey만 사용)
      // spaceKey, spaceId … 등은 받아도 쓰지 않음
    } = body || {};

    const safeTitle = (title || "").toString().trim();
    if (!safeTitle) {
      return res.status(400).json({ error: "Missing 'title'" });
    }

    const parentPageId = (bodyParentPageId || CONFLUENCE_PARENT_PAGE_ID || "").toString().trim();

    const payload = {
      type: "page",
      title: safeTitle,
      space: { key: CONFLUENCE_SPACE_KEY }, // ★ 여기만 고정
      ...(parentPageId ? { ancestors: [{ id: parentPageId }] } : {}),
      body: {
        storage: {
          value: content || "<p>Empty content</p>",
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

    // 편의: 생성된 페이지 URL 같이 반환
    const baseLink = (data && data._links && data._links.base) || wikiBase.replace(/\/wiki$/, "");
    const webui = data && data._links && data._links.webui;
    const pageUrl = baseLink && webui ? baseLink + webui : null;

    return res.status(200).json({ ok: true, result: data, url: pageUrl });
  } catch (err) {
    console.error("Confluence API error:", err);
    return res.status(500).json({ error: "Unexpected server error", detail: err.message });
  }
};
