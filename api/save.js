// ==========================
// api/save.js
// ==========================
//
// 기능 요약
// - 페이지 생성/수정 + DB 업서트
// - 블록 저장 대상 선택: 별도 페이지("page") | DB row 자체("db")
// - content를 DB 속성에 저장할지 여부 선택(contentToProperty)
// - date 기본값 now, url 기본값 pageUrl
// - 자식(children)도 동일 규칙 적용
// - 변경감지: contentHash/changed/rev/contentLen/modifiedAt (DB에 있으면 자동 기록)
//
// 바디 옵션(신규/기존)
// - blocksTarget: "page" | "db"  (기본: "page")
// - contentToProperty: true | false (기본: true)

const { Client } = require("@notionhq/client");
const crypto = require("crypto");
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

/** 🔹 보조 컬럼 키들 자동 탐색 (있으면 사용) */
function resolveAuxKeys(dbProps) {
  const entries = Object.entries(dbProps || {});
  const lower = (s) => String(s || "").trim().toLowerCase();
  const byType = (t) => entries.filter(([_, v]) => v?.type === t);
  const findByNames = (names, type) => {
    const set = new Set(names.map(lower));
    for (const [name, p] of entries) {
      if (set.has(lower(name)) && (!type || p?.type === type)) return name;
    }
    return null;
  };

  const contentHashKey =
    findByNames(["contenthash", "hash", "해시"], "rich_text") ||
    null;
  const changedKey =
    findByNames(["changed", "변경됨", "수정됨"], "checkbox") ||
    null;
  const revKey =
    findByNames(["rev", "version", "버전"], "number") ||
    null;
  const contentLenKey =
    findByNames(["contentlen", "length", "len", "글자수"], "number") ||
    null;
  const modifiedAtKey =
    findByNames(["modifiedat", "updatedat", "수정일", "업데이트"], "date") ||
    null;

  return { contentHashKey, changedKey, revKey, contentLenKey, modifiedAtKey };
}

/** 🔹 기존 row에서 rich_text/plain/number값 읽기 */
function getRichTextPlain(prop) {
  const arr = prop?.rich_text || [];
  return arr.map((t) => t?.plain_text || t?.text?.content || "").join("");
}
function getNumber(prop) {
  return typeof prop?.number === "number" ? prop.number : null;
}
function getCheckbox(prop) {
  return typeof prop?.checkbox === "boolean" ? prop.checkbox : null;
}

/** 🔹 SHA-256 해시 */
function sha256(str) {
  return crypto.createHash("sha256").update(String(str || ""), "utf8").digest("hex");
}

/**
 * 🔹 DB 1행 업서트
 * - 변경감지: contentHash 비교 → changed/rev/contentLen/modifiedAt 세팅
 * - found: pageIdKey == pageId 로 찾음 (제공된 경우)
 * - not found & selfAssignPageId=true: 일단 생성 후 자기 id/URL 기록
 * - forceUrlFromRow=true: row의 url을 가져와 url/pageUrl 컬럼에 기록
 * - saveContentProperty=false: content 컬럼 미기록
 */
async function upsertDbForPage(notion, databaseId, meta) {
  const {
    pageId,         // 일반 모드: 참조용 pageId | DB모드 신규: 비울 수 있음
    pageUrl,        // 일반 모드: 참조 페이지 URL
    title,
    url: bodyUrl,
    date: bodyDate,
    tags,
    status,
    contentText,
    createdAt,      // ISO string
    selfAssignPageId = false,
    forceUrlFromRow = false,
    saveContentProperty = true,
  } = meta;

  const nowIso = createdAt || new Date().toISOString();
  const newHash = sha256(contentText || "");
  const newLen = (contentText || "").length;

  const db = await notion.databases.retrieve({ database_id: databaseId });
  const map = makePropertyMapper(db?.properties || {});
  let {
    titleKey, urlKey, dateKey, tagsKey, statusKey, pageIdKey, pageUrlKey, contentKey: mappedContentKey
  } = map;

  // 오타 pageld 허용
  if (!pageIdKey) {
    for (const [name, p] of Object.entries(db?.properties || {})) {
      if (String(name).trim().toLowerCase() === "pageld" && p?.type === "rich_text") {
        pageIdKey = name;
        break;
      }
    }
  }
  if (!titleKey) throw Object.assign(new Error("DB에 제목(title) 프로퍼티가 없습니다."), { status: 400 });
  if (!pageIdKey) throw Object.assign(new Error("DB에 pageId(또는 pageld) 프로퍼티가 필요합니다."), { status: 400 });

  // 보조 키
  const finalDateKey = dateKey || findFirstTypeKey(db?.properties, "date");
  const finalUrlKey  = urlKey  || (() => {
    for (const [name, p] of Object.entries(db?.properties || {})) {
      if (p?.type === "url" && String(name).toLowerCase() === "url") return name;
    }
    return findFirstTypeKey(db?.properties, "url");
  })();

  const exclude = [titleKey, pageIdKey, finalUrlKey, pageUrlKey].filter(Boolean);
  const contentKey = mappedContentKey || resolveContentKey(db?.properties, exclude);

  // 변경감지 키들
  const { contentHashKey, changedKey, revKey, contentLenKey, modifiedAtKey } = resolveAuxKeys(db?.properties || {});

  // 기존 row 조회 (pageId가 있으면 그걸로)
  let found = null;
  if (pageId) {
    const rs = await notion.databases.query({
      database_id: databaseId,
      filter: { property: pageIdKey, rich_text: { equals: String(pageId) } },
      page_size: 1,
    });
    if (rs.results?.length) found = rs.results[0];
  }

  // 이전 값
  let prevHash = null;
  let prevRev = 0;
  if (found) {
    if (contentHashKey) prevHash = getRichTextPlain(found.properties?.[contentHashKey]);
    if (revKey) {
      const n = getNumber(found.properties?.[revKey]);
      if (typeof n === "number") prevRev = n;
    }
  }
  const isChanged = prevHash ? prevHash !== newHash : true;

  // row URL 가져오기
  const getRowUrl = async (id) => {
    const r = await notion.pages.retrieve({ page_id: id });
    return r?.url || `https://www.notion.so/${id.replace(/-/g, "")}`;
  };

  // 공용 프로퍼티 빌더
  const buildProps = ({ rowUrl, setSelfId }) => {
    const props = {};
    // 제목
    props[titleKey] = { title: [{ type: "text", text: { content: String(title || "") } }] };

    // pageId
    if (pageIdKey && (pageId || setSelfId)) {
      const value = setSelfId ? String(setSelfId) : String(pageId);
      props[pageIdKey] = { rich_text: [{ text: { content: value } }] };
    }

    // pageUrl 전용 키
    if (rowUrl && pageUrlKey) props[pageUrlKey] = { url: String(rowUrl) };

    // url(일반)
    if (finalUrlKey) {
      const chosenUrl =
        (forceUrlFromRow && rowUrl) ? String(rowUrl) :
        (bodyUrl ? String(bodyUrl) : String(pageUrl || rowUrl || ""));
      props[finalUrlKey] = { url: chosenUrl };
    }

    // date (요청 우선, 없으면 now)
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

    // content rich_text 스냅샷
    if (saveContentProperty && contentKey && typeof contentText === "string") {
      props[contentKey] = { rich_text: toRichTextArray(contentText) };
    }

    // 변경 감지 관련
    if (contentHashKey) {
      props[contentHashKey] = { rich_text: [{ type: "text", text: { content: newHash } }] };
    }
    if (contentLenKey) {
      props[contentLenKey] = { number: newLen };
    }
    if (changedKey) {
      props[changedKey] = { checkbox: !!isChanged };
    }
    if (revKey && isChanged) {
      props[revKey] = { number: prevRev + 1 };
    }
    if (modifiedAtKey && isChanged) {
      props[modifiedAtKey] = { date: { start: nowIso } };
    }

    return props;
  };

  if (found) {
    const rowUrl = forceUrlFromRow ? await getRowUrl(found.id) : undefined;
    const updated = await notion.pages.update({
      page_id: found.id,
      properties: buildProps({ rowUrl }),
    });
    return { rowId: updated.id, rowUrl: rowUrl || updated.url };
  } else {
    // 신규 생성 → 1차 생성
    const created = await notion.pages.create({
      parent: { database_id: databaseId },
      properties: buildProps({ rowUrl: undefined }),
    });

    // 2차 업데이트: 자기 URL/자기 ID 보정
    const rowUrl = await getRowUrl(created.id);
    const secondProps = buildProps({ rowUrl, setSelfId: selfAssignPageId ? created.id : undefined });
    // pageIdKey를 자기 자신으로 강제하고 싶은 경우 setSelfId 사용
    await notion.pages.update({ page_id: created.id, properties: secondProps });

    return { rowId: created.id, rowUrl };
  }
}

/** 🔹 자식 페이지 재귀 생성 + DB 동기화 */
async function createChildrenRecursively(notion, parentPageId, databaseId, children = [], options = {}) {
  const out = [];
  const nowIso = new Date().toISOString();
  const { blocksTarget = "page", contentToProperty = true } = options;

  for (const child of children) {
    const cTitle = deriveTitle(child.title, child.content);
    const cleanedChild = typeof child.content === "string"
      ? removeTitleFromContent(cTitle, child.content)
      : "";

    let pageIdForBlocks = null;
    let pageUrl = null;
    let dbInfo = null;

    if (blocksTarget === "db" && databaseId) {
      // DB row에 블록 저장
      const up = await upsertDbForPage(notion, databaseId, {
        pageId: child.pageId,
        pageUrl: null,
        title: cTitle,
        url: child.url,
        date: child.date,
        tags: child.tags,
        status: child.status,
        contentText: cleanedChild,
        createdAt: nowIso,
        selfAssignPageId: true,
        forceUrlFromRow: true,
        saveContentProperty: !!contentToProperty,
      });
      dbInfo = { rowId: up.rowId };
      pageIdForBlocks = up.rowId;
      pageUrl = up.rowUrl;

      await deleteAllChildren(notion, pageIdForBlocks);
      await appendInChunks(notion, pageIdForBlocks, toBlocks(cleanedChild || ""));
    } else {
      // 별도 페이지 생성 후 블록 저장
      const pageResult = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ type: "text", text: { content: String(cTitle) } }] },
        },
      });
      pageIdForBlocks = pageResult.id;
      pageUrl = pageResult.url || `https://www.notion.so/${pageIdForBlocks.replace(/-/g, "")}`;
      await appendInChunks(notion, pageIdForBlocks, toBlocks(cleanedChild || ""));

      if (databaseId) {
        const up = await upsertDbForPage(notion, databaseId, {
          pageId: pageIdForBlocks,
          pageUrl,
          title: cTitle,
          url: child.url,
          date: child.date,
          tags: child.tags,
          status: child.status,
          contentText: cleanedChild,
          createdAt: nowIso,
          selfAssignPageId: false,
          forceUrlFromRow: false,
          saveContentProperty: !!contentToProperty,
        });
        dbInfo = { rowId: up.rowId };
      }
    }

    let nested = [];
    if (Array.isArray(child.children) && child.children.length) {
      nested = await createChildrenRecursively(
        notion,
        pageIdForBlocks,
        databaseId,
        child.children,
        options
      );
    }

    out.push({ id: pageIdForBlocks, url: pageUrl, db: dbInfo, children: nested });
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
      title, content, url, date, tags, status,
      children,

      // 옵션
      blocksTarget = "page",        // "page" | "db"
      contentToProperty = true      // true | false
    } = body || {};

    const parentPageId = toUuid(parentOverride || NOTION_PAGE_ID || "");
    const databaseId = toUuid(databaseOverride || NOTION_DATABASE_ID || "");

    if (!inputPageId && !parentPageId && blocksTarget !== "db") {
      return res.status(400).json({ error: "parentPageId 필수 (blocksTarget='page')" });
    }
    if (!databaseId && blocksTarget === "db") {
      return res.status(400).json({ error: "blocksTarget='db' 모드에서는 databaseId 필수" });
    }

    const finalTitle = deriveTitle(title, content);
    const cleaned = removeTitleFromContent(finalTitle, content);
    const blocks = typeof cleaned === "string" ? toBlocks(cleaned) : [];

    let pageId = toUuid(inputPageId || "");
    let pageUrl, pageResult;
    const nowIso = new Date().toISOString();
    let dbInfo = null;

    if (blocksTarget === "db") {
      // DB row에 블록 저장
      const up = await upsertDbForPage(notion, databaseId, {
        pageId,
        pageUrl: null,
        title: finalTitle,
        url,
        date,
        tags,
        status,
        contentText: typeof cleaned === "string" ? cleaned : "",
        createdAt: nowIso,
        selfAssignPageId: !pageId,
        forceUrlFromRow: true,
        saveContentProperty: !!contentToProperty
      });

      pageId = up.rowId;
      pageUrl = up.rowUrl || `https://www.notion.so/${pageId.replace(/-/g, "")}`;
      dbInfo = { rowId: up.rowId };

      await deleteAllChildren(notion, pageId);
      await appendInChunks(notion, pageId, blocks);
    } else {
      // 별도 페이지에 블록 저장
      if (pageId) {
        await notion.pages.update({
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

      if (databaseId) {
        const up = await upsertDbForPage(notion, databaseId, {
          pageId,
          pageUrl,
          title: finalTitle,
          url,
          date,
          tags,
          status,
          contentText: typeof cleaned === "string" ? cleaned : "",
          createdAt: nowIso,
          selfAssignPageId: false,
          forceUrlFromRow: false,
          saveContentProperty: !!contentToProperty
        });
        dbInfo = { rowId: up.rowId };
      }
    }

    const createdChildren =
      Array.isArray(children) && children.length
        ? await createChildrenRecursively(
            notion,
            pageId,
            databaseId,
            children,
            { blocksTarget, contentToProperty }
          )
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
