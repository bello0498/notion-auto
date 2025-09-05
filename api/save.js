// ==========================
// api/save.js
// ==========================

const { Client } = require("@notionhq/client");
const { toBlocks } = require("../lib/toBlocks");
const { toUuid, deriveTitle, makePropertyMapper } = require("../lib/notionUtil");

// 📥 JSON 바디 파싱 유틸
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

// 🔧 content 첫 줄에 제목이 포함된 경우 제거
function removeTitleFromContent(title, content) {
  const lines = content.split("\n").map((l) => l.trim());
  if (lines[0].replace(/^#+\s*/, "") === title.trim()) {
    return lines.slice(1).join("\n");
  }
  return content;
}

module.exports = async (req, res) => {
  // 🔐 CORS 및 헤더 설정
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");

  // 🔄 Preflight 요청
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // 🛠️ 환경 변수
  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN env" });

  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);

  // 🧾 요청 파라미터
  const {
    title,
    content,
    url,
    date,
    tags,
    status,
    pageId: inputPageId,
    databaseId,
  } = body || {};

  const results = {};

  try {
    // ✅ DB 정보 확인
    const dbId = toUuid(databaseId || NOTION_DATABASE_ID || "");
    if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env" });

    // ✨ 제목 생성 (없으면 content에서 추출)
    const finalTitle = deriveTitle(title, content);

    // 📂 DB 스키마 분석 (title, status 등 속성 매핑)
    const db = await notion.databases.retrieve({ database_id: dbId });
    const {
      titleKey,
      urlKey,
      dateKey,
      tagsKey,
      statusKey,
      pageIdKey,
      pageUrlKey,
    } = makePropertyMapper(db?.properties || {});
    if (!titleKey) return res.status(400).json({ error: "No title property in DB" });

    let newPageId = inputPageId;
    const isUpdate = !!inputPageId;

    // ✅ 1. 페이지가 없으면 새로 생성
    if (!newPageId) {
      const properties = {};
      properties[titleKey] = {
        title: [{ type: "text", text: { content: String(finalTitle) } }],
      };
      if (url && urlKey) properties[urlKey] = { url: String(url) };
      if (date && dateKey) properties[dateKey] = { date: { start: String(date) } };
      if (Array.isArray(tags) && tags.length && tagsKey) {
        properties[tagsKey] = {
          multi_select: tags.map((t) => ({ name: String(t) })),
        };
      }
      if (status && statusKey) {
        properties[statusKey] = { select: { name: String(status) } };
      }

      // 🆕 DB에 새 아이템 생성
      const dbPage = await notion.pages.create({
        parent: { database_id: dbId },
        properties,
      });

      newPageId = dbPage.id;

      // 🔗 페이지 URL 추출
      const pageUrl = `https://www.notion.so/${newPageId.replace(/-/g, "")}`;

      // 🔄 페이지 ID & URL을 DB에 업데이트
      const updateProps = {};
      if (pageIdKey)
        updateProps[pageIdKey] = {
          rich_text: [{ text: { content: newPageId } }],
        };
      if (pageUrlKey)
        updateProps[pageUrlKey] = { url: pageUrl };

      if (Object.keys(updateProps).length) {
        await notion.pages.update({
          page_id: newPageId,
          properties: updateProps,
        });
      }

      results.db = newPageId;
      results.url = pageUrl;
    } else {
      // 🔄 기존 페이지 수정
      results.db = newPageId;
      results.url = `https://www.notion.so/${newPageId.replace(/-/g, "")}`;
    }

    // ✅ 2. 블록 내용 업데이트 (내용이 있을 경우)
    if (content && newPageId) {
      const cleaned = removeTitleFromContent(finalTitle, content);
      const blocks = toBlocks(cleaned);

      // 이전 블록 삭제
      const oldBlocks = await notion.blocks.children.list({ block_id: newPageId });
      for (const block of oldBlocks.results) {
        await notion.blocks.delete({ block_id: block.id });
      }

      // 새 블록 추가
      await notion.blocks.children.append({
        block_id: newPageId,
        children: blocks,
      });
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const statusCode = err?.status || err?.response?.status || 500;
    return res.status(statusCode).json({
      error: "Failed to save to Notion",
      detail: err?.response?.data || err?.message || "Unknown",
    });
  }
};
