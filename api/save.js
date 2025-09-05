// ==========================
// api/save.js
// ==========================
//
// 목적:
// - 페이지 생성/수정 + DB 동기화(both)
// - 생성: 새 페이지 만들면 DB에도 새 row 생성
// - 수정: 기존 페이지 수정 시 DB row 업데이트
// - 하위메뉴: children[] 재귀 생성 + DB 동기화
//
// 포함 기능:
// 1) 제목 추출(deriveTitle)
// 2) 본문 첫 줄(제목) 중복 제거
// 3) 옵션 반영(tags/status/date/url) + content 저장(rich_text)
// 4) 블록 삭제/추가 시 페이징 처리
// 5) DB upsert(pageId 기준)
// 6) date 기본값: now(ISO)
// 7) url 기본값: 생성된 페이지의 pageUrl
// 8) pageIdKey가 없을 경우 'pageld' 오타 컬럼 자동 인식

const { Client } = require("@notionhq/client");
const { toBlocks } = require("../lib/toBlocks");
const { toUuid, deriveTitle, makePropertyMapper } = require("../lib/notionUtil");

/** 🔹 JSON 바디 파싱 */
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

/** 🔹 제목과 본문 첫 줄 중복 제거 */
function removeTitleFromContent(title, content) {
  const raw = String(content || "");
  const lines = raw.split("\n");
  const first = (lines[0] || "").replace(/^#+\s*/, "").trim();
  if (title && first === String(title).trim()) {
    return lines.slice(1).join("\n");
  }
  return raw;
}

/** 🔹 하위 블록 전부 삭제 (100개 단위) */
async function deleteAllChildren(notion, blockId) {
  let cursor;
  do {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of resp.results) {
      await notion.blocks.delete({ block_id: b.id });
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
}

/** 🔹 블록 추가를 100개씩 분할 */
async function appendInChunks(notion, blockId, blocks) {
  if (!blocks || !blocks.length) return;
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: blockId,
      children: blocks.slice(i, i + 100),
    });
  }
}

/** 🔹 긴 텍스트 → rich_text 배열 (안전 분할) */
function toRichTextArray(str) {
  const s = String(str || "");
  if (!s) return [{ type: "text", text: { content: "" } }];
  const out = [];
  const CHUNK = 1900; // 여유 버퍼
  for (let i = 0; i < s.length; i += CHUNK) {
    out.push({ type: "text", text: { content: s.slice(i, i + CHUNK) } });
  }
  return out;
}

/** 🔹 DB 내 특정 타입의 첫 번째 프로퍼티 키 */
function findFirstTypeKey(props, type) {
  for (const [name, p] of Object.entries(props || {})) {
    if (p?.type === type) return name;
  }
  return null;
}

/** 🔹 content 후보 rich_text 프로퍼티 찾기 */
function resolveContentKey(props, exclude = []) {
  const preferNames = ["content", "본문", "내용", "body", "text", "텍스트"];
  const lower = (v) => String(v || "").toLowerCase();

  // 1) 이름 우선
  for (const [name, p] of Object.entries(props || {})) {
    if (p?.type === "rich_text" && !exclude.includes(name)) {
      if (preferNames.includes(lower(name))) return name;
    }
  }
  // 2) 아무 rich_text나
  for (const [name, p] of Object.entries(props || {})) {
    if (p?.type === "rich_text" && !exclude.includes(name)) {
      return name;
    }
  }
  return null;
}

/**
 * 🔹 DB 1행 업서트 (있으면 수정, 없으면 생성)
 * - pageId 기준
 * - date/url 기본값 처리
 * - content 저장
 * - 'pageld' 오타 컬럼 자동 인식
 */
async function upsertDbForPage(notion, databaseId, meta) {
  const {
    pageId,
    pageUrl,
    title,
    url: bodyUrl,
    date: bodyDate,
    tags,
    status,
    contentText,
    createdAt, // ISO string
  } = meta;

  const nowIso = createdAt || new Date().toISOString();

  const db = await notion.databases.retrieve({ database_id: databaseId });
  const map = makePropertyMapper(db?.properties || {});
  let {
    titleKey,
    urlKey,
    dateKey,
    tagsKey,
    statusKey,
    pageIdKey,
    pageUrlKey,
  } = map;

  // 🔸 pageIdKey가 없으면 'pageld' 오타 컬럼을 rich_text로 탐색
  if (!pageIdKey) {
    for (const [name, p] of Object.entries(db?.properties || {})) {
      if (String(name).trim().toLowerCase() === "pageld" && p?.type === "rich_text") {
        pageIdKey = name;
        break;
      }
    }
  }

  if (!titleKey) {
    throw Object.assign(new Error("DB에 제목(title) 프로퍼티가 없습니다."), {
      status: 400,
    });
  }
  if (!pageIdKey) {
    throw Object.assign(new Error("DB에 pageId(또는 pageld) 프로퍼티가 필요합니다."), {
      status: 400,
    });
  }

  // 🔸 보조 키: date/url 자동 보정
  const finalDateKey = dateKey || findFirstTypeKey(db?.properties, "date");
  const finalUrlKey =
    urlKey ||
    (() => {
      for (const [name, p] of Object.entries(db?.properties || {})) {
        if (p?.type === "url" && String(name).toLowerCase() === "url") return name;
      }
      return findFirstTypeKey(db?.properties, "url");
    })();

  // 🔸 content key 결정(제목/ID/URL 컬럼 제외)
  const exclude = [titleKey, pageIdKey, finalUrlKey, pageUrlKey].filter(Boolean);
  const contentKey = resolveContentKey(db?.properties, exclude);

  // 🔸 기존 row 조회(pageId 기준)
  const found = await notion.databases.query({
    database_id: databaseId,
    filter: { property: pageIdKey, rich_text: { equals: String(pageId) } },
    page_size: 1,
  });

  // 🔸 프로퍼티 구성
  const props = {};

  // 제목
  props[titleKey] = {
    title: [{ type: "text", text: { content: String(title || "") } }],
  };

  // pageId
  if (pageIdKey) {
    props[pageIdKey] = { rich_text: [{ text: { content: String(pageId) } }] };
  }

  // pageUrl 전용 키
  if (pageUrl && pageUrlKey) {
    props[pageUrlKey] = { url: String(pageUrl) };
  }

  // url(일반) → 요청 url 우선, 없으면 pageUrl
  if (finalUrlKey) {
    const chosenUrl = bodyUrl ? String(bodyUrl) : String(pageUrl || "");
    props[finalUrlKey] = { url: chosenUrl };
  }

  // date → 요청 date 우선, 없으면 now
  if (finalDateKey) {
    const chosenDate = bodyDate ? String(bodyDate) : String(nowIso);
    props[finalDateKey] = { date: { start: chosenDate } };
  }

  // tags
  if (Array.isArray(tags) && tags.length && tagsKey) {
    props[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
  }

  // status
  if (status && statusKey) {
    props[statusKey] = { select: { name: String(status) } };
  }

  // content (rich_text)
  if (contentKey && typeof contentText === "string") {
    props[contentKey] = { rich_text: toRichTextArray(contentText) };
  }

  if (found.results?.length) {
    const updated = await notion.pages.update({
      page_id: found.results[0].id,
      properties: props,
    });
    return { rowId: updated.id };
  } else {
    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      properties: props,
    });
    return { rowId: created.id };
  }
}

/** 🔹 자식 페이지 재귀 생성 + DB 동기화 */
async function createChildrenRecursively(notion, parentPageId, databaseId, children = []) {
  const out = [];
  const nowIso = new Date().toISOString();

  for (const child of children) {
    const cTitle = deriveTitle(child.title, child.content);

    const newPage = await notion.pages.create({
      parent: { page_id: parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: String(cTitle) } }] },
      },
    });

    let cleanedChild = "";
    if (typeof child.content === "string") {
      cleanedChild = removeTitleFromContent(cTitle, child.content);
      await appendInChunks(notion, newPage.id, toBlocks(cleanedChild || ""));
    }

    const pageUrl =
      newPage.url || `https://www.notion.so/${newPage.id.replace(/-/g, "")}`;

    let dbInfo = null;
    if (databaseId) {
      dbInfo = await upsertDbForPage(notion, databaseId, {
        pageId: newPage.id,
        pageUrl,
        title: cTitle,
        url: child.url, // 바디에 없으면 pageUrl 사용
        date: child.date, // 바디에 없으면 now 사용
        tags: child.tags,
        status: child.status,
        contentText: cleanedChild,
        createdAt: nowIso,
      });
    }

    let nested = [];
    if (Array.isArray(child.children) && child.children.length) {
      nested = await createChildrenRecursively(
        notion,
        newPage.id,
        databaseId,
        child.children
      );
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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept-Charset"
  );
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
      title,
      content,
      url,
      date,
      tags,
      status,
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
    const nowIso = new Date().toISOString();

    if (pageId) {
      // 수정
      pageResult = await notion.pages.update({
        page_id: pageId,
        properties: {
          title: { title: [{ type: "text", text: { content: String(finalTitle) } }] },
        },
      });
      if (typeof content === "string") {
        await deleteAllChildren(notion, pageId);
        await appendInChunks(notion, pageId, blocks);
      }
      pageUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
    } else {
      // 생성
      pageResult = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ type: "text", text: { content: String(finalTitle) } }] },
        },
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
        url,   // 없으면 pageUrl 사용
        date,  // 없으면 now 사용
        tags,
        status,
        contentText: typeof cleaned === "string" ? cleaned : "",
        createdAt: nowIso,
      });
    }

    const createdChildren =
      Array.isArray(children) && children.length
        ? await createChildrenRecursively(notion, pageId, databaseId, children)
        : [];

    return res.status(200).json({
      ok: true,
      results: {
        page: { id: pageId, url: pageUrl, modifiedAt: nowIso },
        db: dbInfo,
        children: createdChildren,
      },
    });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const code = err?.status || err?.response?.status || 500;
    return res
      .status(code)
      .json({ error: "Failed to save", detail: err?.response?.data || err?.message || "Unknown" });
  }
};
