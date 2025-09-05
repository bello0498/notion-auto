// ==========================
// api/save.js
// ==========================
//
// 목적:
// - 기본 동작은 "both": 노션 페이지 + DB 동기화
// - 생성: 새 페이지 만들면 DB에도 새 row 생성
// - 수정: 기존 페이지가 수정되면 DB row도 업데이트
// - 하위메뉴: children[] 구조로 재귀 생성 및 DB 동기화
//
// 요약 요구사항:
// 1) 제목 추출
// 2) 본문 첫 줄 중복 제거
// 3) 옵션 반영(tags/status/date/url)
// 4) 블록 삭제/추가 시 페이징 처리
// 5) DB: pageId 기준으로 새 row 생성 또는 수정(upsert)

const { Client } = require("@notionhq/client");
const { toBlocks } = require("../lib/toBlocks");
const { toUuid, deriveTitle, makePropertyMapper } = require("../lib/notionUtil");

/** 🔹 JSON 바디 파싱 */
async function readJSON(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

/** 🔹 제목과 본문 첫 줄 중복 제거 */
function removeTitleFromContent(title, content) {
  const raw = String(content || "");
  const lines = raw.split("\n");
  const first = (lines[0] || "").replace(/^#+\s*/, "").trim();
  if (title && first === title.trim()) {
    return lines.slice(1).join("\n");
  }
  return raw;
}

/** 🔹 하위 블록 전부 삭제 (100개 단위) */
async function deleteAllChildren(notion, blockId) {
  let cursor;
  do {
    const resp = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    for (const b of resp.results) await notion.blocks.delete({ block_id: b.id });
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
}

/** 🔹 블록 추가를 100개씩 분할 */
async function appendInChunks(notion, blockId, blocks) {
  if (!blocks || !blocks.length) return;
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({ block_id: blockId, children: blocks.slice(i, i + 100) });
  }
}

/**
 * 🔹 DB 1행 업서트 (있으면 수정, 없으면 생성)
 */
async function upsertDbForPage(notion, databaseId, meta) {
  const { pageId, pageUrl, title, url, date, tags, status } = meta;

  const db = await notion.databases.retrieve({ database_id: databaseId });
  const { titleKey, urlKey, dateKey, tagsKey, statusKey, pageIdKey, pageUrlKey } = makePropertyMapper(db?.properties || {});

  if (!titleKey) throw Object.assign(new Error("DB에 제목(title) 프로퍼티가 없습니다."), { status: 400 });
  if (!pageIdKey) throw Object.assign(new Error("DB에 pageIdKey가 필요합니다."), { status: 400 });

  const found = await notion.databases.query({
    database_id: databaseId,
    filter: { property: pageIdKey, rich_text: { equals: String(pageId) } },
    page_size: 1,
  });

  const props = {};
  props[titleKey] = { title: [{ type: "text", text: { content: String(title || "") } }] };
  if (pageIdKey) props[pageIdKey] = { rich_text: [{ text: { content: String(pageId) } }] };
  if (pageUrl && pageUrlKey) props[pageUrlKey] = { url: String(pageUrl) };
  if (url && urlKey) props[urlKey] = { url: String(url) };
  if (date && dateKey) props[dateKey] = { date: { start: String(date) } };
  if (Array.isArray(tags) && tags.length && tagsKey) props[tagsKey] = { multi_select: tags.map(t => ({ name: String(t) })) };
  if (status && statusKey) props[statusKey] = { select: { name: String(status) } };

  if (found.results?.length) {
    const updated = await notion.pages.update({ page_id: found.results[0].id, properties: props });
    return { rowId: updated.id };
  } else {
    const created = await notion.pages.create({ parent: { database_id: databaseId }, properties: props });
    return { rowId: created.id };
  }
}

/** 🔹 자식 페이지 재귀 생성 + DB 동기화 */
async function createChildrenRecursively(notion, parentPageId, databaseId, children = []) {
  const out = [];
  for (const child of children) {
    const cTitle = deriveTitle(child.title, child.content);
    const newPage = await notion.pages.create({
      parent: { page_id: parentPageId },
      properties: { title: { title: [{ type: "text", text: { content: String(cTitle) } }] } },
    });

    if (typeof child.content === "string") {
      const cleaned = removeTitleFromContent(cTitle, child.content);
      await appendInChunks(notion, newPage.id, toBlocks(cleaned || ""));
    }

    const pageUrl = newPage.url || `https://www.notion.so/${newPage.id.replace(/-/g, "")}`;

    let dbInfo = null;
    if (databaseId) {
      dbInfo = await upsertDbForPage(notion, databaseId, {
        pageId: newPage.id,
        pageUrl,
        title: cTitle,
        url: child.url,
        date: child.date,
        tags: child.tags,
        status: child.status,
      });
    }

    let nested = [];
    if (Array.isArray(child.children) && child.children.length) {
      nested = await createChildrenRecursively(notion, newPage.id, databaseId, child.children);
    }

    out.push({ id: newPage.id, url: pageUrl, db: dbInfo, children: nested });
  }
  return out;
}

module.exports = async (req, res) => {
  // ▷ 공통 헤더/CORS
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { NOTION_TOKEN, NOTION_PAGE_ID, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN env" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    const body = await readJSON(req);
    const {
      pageId: inputPageId,
      parentPageId: parentOverride,
      databaseId: databaseOverride,
      title, content, url, date, tags, status,
      children,
    } = body || {};

    const parentPageId = toUuid(parentOverride || NOTION_PAGE_ID || "");
    const databaseId = toUuid(databaseOverride || NOTION_DATABASE_ID || "");

    if (!inputPageId && !parentPageId) {
      return res.status(400).json({ error: "parentPageId 필수" });
    }

    const finalTitle = deriveTitle(title, content);
    const cleaned = removeTitleFromContent(finalTitle, content);
    const blocks = typeof cleaned === "string" ? toBlocks(cleaned) : [];

    let pageId = toUuid(inputPageId || "");
    let pageUrl, pageResult;
    const modifiedAt = new Date().toISOString();

    if (pageId) {
      pageResult = await notion.pages.update({
        page_id: pageId,
        properties: { title: { title: [{ type: "text", text: { content: String(finalTitle) } }] } },
      });
      if (typeof content === "string") {
        await deleteAllChildren(notion, pageId);
        await appendInChunks(notion, pageId, blocks);
      }
      pageUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
    } else {
      pageResult = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: { title: { title: [{ type: "text", text: { content: String(finalTitle) } }] } },
      });
      pageId = pageResult.id;
      pageUrl = pageResult.url || `https://www.notion.so/${pageId.replace(/-/g, "")}`;
      await appendInChunks(notion, pageId, blocks);
    }

    let dbInfo = null;
    if (databaseId) {
      dbInfo = await upsertDbForPage(notion, databaseId, {
        pageId,
        pageUrl,
        title: finalTitle,
        url,
        date,
        tags,
        status,
      });
    }

    const createdChildren = Array.isArray(children) && children.length
      ? await createChildrenRecursively(notion, pageId, databaseId, children)
      : [];

    return res.status(200).json({
      ok: true,
      results: {
        page: { id: pageId, url: pageUrl, modifiedAt },
        db: dbInfo,
        children: createdChildren,
      },
    });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const code = err?.status || err?.response?.status || 500;
    return res.status(code).json({ error: "Failed to save", detail: err?.response?.data || err?.message || "Unknown" });
  }
};
