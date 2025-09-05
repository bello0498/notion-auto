// ==========================
// api/save.js
// ==========================
//
// 목적:
// - 기본 동작은 "both": 노션 페이지(실물) + DB(메타 1행) 동시 반영
// - 생성: parent 페이지 아래 새 페이지 생성 → DB에 pageId/pageUrl 포함 1행 업서트
// - 수정: pageId로 기존 페이지 제목/본문 교체 → DB도 같은 pageId 행만 업데이트
// - 하위메뉴(자식 페이지): children[] 구조로 전달 시 재귀적으로 생성 + DB 동기화
//
// 요구사항 반영 요약:
// 1) 제목: title || content 첫 줄에서 추출
// 2) 본문 첫 줄이 제목과 같으면 제거(중복 방지)
// 3) tags/status/date/url은 옵션(있으면 반영), tags는 미등록 값 자동 생성 허용
// 4) 블록 삭제/추가 시 페이지네이션·청크 처리
// 5) DB는 반드시 pageIdKey로 "1 페이지 = 1 행" 업서트(로그처럼 누적 금지)
//

const { Client } = require("@notionhq/client");
const { toBlocks } = require("../lib/toBlocks");
const { toUuid, deriveTitle, makePropertyMapper } = require("../lib/notionUtil");

/** 🔹 JSON 바디 파싱(스트림 대응) */
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

/** 🔹 본문 첫 줄이 제목과 같으면 제거(중복 방지) */
function removeTitleFromContent(title, content) {
  const raw = String(content || "");
  const lines = raw.split("\n").map((l) => l);
  const first = (lines[0] || "").replace(/^#+\s*/, "").trim();
  if (String(title || "").trim() && first === String(title || "").trim()) {
    return lines.slice(1).join("\n");
  }
  return raw;
}

/** 🔹 모든 자식 블록 삭제(100개 페이지네이션 대응) */
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

/** 🔹 블록 추가를 100개 단위로 분할(append 제한 대응) */
async function appendInChunks(notion, blockId, blocks) {
  if (!blocks || !blocks.length) return;
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: blockId,
      children: blocks.slice(i, i + 100),
    });
  }
}

/**
 * 🔹 DB 1행 업서트(키: pageIdKey)
 * - 전제: DB에 pageIdKey 속성이 존재해야 중복 없는 업서트 가능
 * - titleKey도 필수(노션 DB는 title 프로퍼티가 반드시 필요)
 */
async function upsertDbForPage(notion, databaseId, meta) {
  const { pageId, pageUrl, title, url, date, tags, status } = meta;

  // DB 스키마 읽어서 실제 키 매핑
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const {
    titleKey,
    urlKey,
    dateKey,
    tagsKey,
    statusKey,
    pageIdKey,
    pageUrlKey,
  } = makePropertyMapper(db?.properties || {});

  // 필수 키 검증
  if (!titleKey) {
    throw Object.assign(new Error("DB에 제목(title) 프로퍼티가 없습니다."), { status: 400 });
  }
  if (!pageIdKey) {
    throw Object.assign(
      new Error("DB에 pageId를 저장할 프로퍼티가 필요합니다. (pageIdKey 매핑 필요)"),
      { status: 400 }
    );
  }

  // 업서트 대상 찾기: pageIdKey == pageId
  let existingRowId = null;
  const found = await notion.databases.query({
    database_id: databaseId,
    filter: { property: pageIdKey, rich_text: { equals: String(pageId) } },
    page_size: 1,
  });
  if (found.results?.length) existingRowId = found.results[0].id;

  // 공통 프로퍼티 구성
  const props = {};
  props[titleKey] = { title: [{ type: "text", text: { content: String(title || "") } }] };
  if (pageIdKey) props[pageIdKey] = { rich_text: [{ text: { content: String(pageId) } }] };
  if (pageUrl && pageUrlKey) props[pageUrlKey] = { url: String(pageUrl) };
  if (url && urlKey) props[urlKey] = { url: String(url) };
  if (date && dateKey) props[dateKey] = { date: { start: String(date) } };
  if (Array.isArray(tags) && tags.length && tagsKey) {
    // 미등록 태그도 이름만 주면 노션에서 옵션 생성됨
    props[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
  }
  if (status && statusKey) props[statusKey] = { select: { name: String(status) } };

  // 업서트 실행
  if (existingRowId) {
    const updated = await notion.pages.update({ page_id: existingRowId, properties: props });
    return { rowId: updated.id };
  } else {
    const created = await notion.pages.create({ parent: { database_id: databaseId }, properties: props });
    return { rowId: created.id };
  }
}

/** 🔹 자식(하위메뉴) 페이지 재귀 생성 + DB 동기화 */
async function createChildrenRecursively(notion, parentPageId, databaseId, children = []) {
  const out = [];
  for (const child of children) {
    // 제목 산출
    const cTitle = deriveTitle(child.title, child.content);

    // 자식 페이지 생성
    const newPage = await notion.pages.create({
      parent: { page_id: parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: String(cTitle) } }] },
      },
    });

    // 본문 구성(첫 줄=제목이면 제거)
    if (typeof child.content === "string") {
      const cleaned = removeTitleFromContent(cTitle, child.content);
      const blocks = toBlocks(cleaned || "");
      await appendInChunks(notion, newPage.id, blocks);
    }

    const pageUrl = newPage.url || `https://www.notion.so/${newPage.id.replace(/-/g, "")}`;

    // DB 동기화(옵션)
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

    // 하위의 하위가 있으면 재귀 생성
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
  res.setHeader("Access-Control-Allow-Origin", "*"); // 실제 배포 시 신뢰 도메인으로 제한 권장
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // ▷ 환경변수 확인
  const { NOTION_TOKEN, NOTION_PAGE_ID, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN env" });

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    // ▷ 요청 파라미터 수신
    const body = await readJSON(req);
    const {
      // 생성/수정 판별
      pageId: inputPageId,            // 있으면 수정, 없으면 생성
      // 기본 parent/db 대체 가능
      parentPageId: parentOverride,   // 없으면 env NOTION_PAGE_ID 사용
      databaseId: databaseOverride,   // 없으면 env NOTION_DATABASE_ID 사용
      // 콘텐츠/메타
      title, content, url, date, tags, status,
      // 하위메뉴 생성
      children,                       // [{ title?, content?, url?, date?, tags?, status?, children? }]
    } = body || {};

    // ▷ parent / database 대상 확정
    const parentPageId = toUuid(parentOverride || NOTION_PAGE_ID || "");
    const databaseId = toUuid(databaseOverride || NOTION_DATABASE_ID || "");

    // 생성 모드에서는 parentPageId 필수
    if (!inputPageId && !parentPageId) {
      return res.status(400).json({ error: "생성에는 parent 페이지 ID가 필요합니다. (env NOTION_PAGE_ID 또는 body.parentPageId)" });
    }

    // ▷ 제목 산출 및 본문 변환
    const finalTitle = deriveTitle(title, content);
    const cleaned = removeTitleFromContent(finalTitle, content);
    const blocks = typeof cleaned === "string" ? toBlocks(cleaned) : [];

    // ▷ 생성/수정 분기
    let pageId = toUuid(inputPageId || "");
    let pageUrl;
    const modifiedAt = new Date().toISOString();

    if (pageId) {
      // ---- 수정: 기존 페이지 제목/본문 교체
      await notion.pages.update({
        page_id: pageId,
        properties: {
          title: { title: [{ type: "text", text: { content: String(finalTitle) } }] },
        },
      });
      if (typeof content === "string") {
        // 본문 완전 교체(요구사항)
        await deleteAllChildren(notion, pageId);
        await appendInChunks(notion, pageId, blocks);
      }
      pageUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
    } else {
      // ---- 생성: parent 아래 새 페이지
      const newPage = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ type: "text", text: { content: String(finalTitle) } }] },
        },
      });
      pageId = newPage.id;
      pageUrl = newPage.url || `https://www.notion.so/${pageId.replace(/-/g, "")}`;

      // 본문 추가
      await appendInChunks(notion, pageId, blocks);
    }

    // ▷ DB 동기화(both가 기본) — DB가 지정되어 있으면 1행 업서트
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

    // ▷ 하위메뉴(자식 페이지) 생성(옵션, 재귀)
    let createdChildren = [];
    if (Array.isArray(children) && children.length) {
      createdChildren = await createChildrenRecursively(notion, pageId, databaseId, children);
    }

    // ▷ 응답
    return res.status(200).json({
      ok: true,
      results: {
        page: { id: pageId, url: pageUrl, modifiedAt },
        db: dbInfo,                // { rowId } | null
        children: createdChildren, // [{ id, url, db?, children? }, ...]
      },
    });
  } catch (err) {
    // ▷ 에러 로깅/응답(상태코드 최대한 보존)
    console.error("Save API error:", err?.response?.data || err);
    const statusCode = err?.status || err?.response?.status || 500;
    return res.status(statusCode).json({
      error: "Failed to save",
      detail: err?.response?.data || err?.message || "Unknown",
    });
  }
};
