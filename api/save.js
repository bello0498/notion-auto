// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");

// ---------- helpers ----------
const normalize = (s) => String(s || "").trim().toLowerCase();
const toUuid = (id = "") =>
  /^[0-9a-fA-F]{32}$/.test(id)
    ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
    : id;

// 제목 자동 생성: 입력 title > content 첫 줄 > 시간기반 기본값
function deriveTitle(title, content) {
  const t = String(title || "").trim();
  if (t) return t;
  const firstLine = String(content || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) || "";
  if (firstLine) return firstLine.replace(/^#+\s*|^[-*]\s*/, "").slice(0, 80);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Auto Note ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 확장된 Markdown-ish -> Notion blocks 변환기
function toBlocks(raw = "") {
  const lines = String(raw).split("\n").map((l) => l.trimEnd());
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    
    // 빈 줄 건너뛰기
    if (!line.trim()) {
      i++;
      continue;
    }

    // 1️⃣ 헤딩 처리
    if (line.startsWith("### ")) {
      blocks.push({
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] }
      });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] }
      });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({
        type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] }
      });
      i++;
      continue;
    }

    // 2️⃣ 코드블록 처리
    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || "plain text";
      const codeLines = [];
      i++; // ``` 다음 줄부터 시작
      
      // 종료 ``` 찾을 때까지 수집
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      
      blocks.push({
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }],
          language: language.toLowerCase()
        }
      });
      i++; // 종료 ``` 건너뛰기
      continue;
    }

    // 3️⃣ 테이블 처리 🔥
    if (line.includes("|") && lines[i + 1]?.includes("|") && lines[i + 1].includes("-")) {
      const tableLines = [line];
      const headerSeparator = lines[i + 1]; // |------|------|
      i += 2; // 헤더와 구분선 건너뛰기
      
      // 테이블 행들 수집
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      
      // 테이블 파싱
      const parseTableRow = (row) => {
        return row.split("|")
          .map(cell => cell.trim())
          .filter(cell => cell.length > 0); // 빈 셀 제거
      };
      
      const headers = parseTableRow(tableLines[0]);
      const rows = tableLines.slice(1).map(parseTableRow);
      
      // Notion 테이블 블록 생성
      if (headers.length > 0 && rows.length > 0) {
        const tableWidth = Math.max(headers.length, ...rows.map(row => row.length));
        const tableChildren = [];
        
        // 헤더 행
        tableChildren.push({
          type: "table_row",
          table_row: {
            cells: headers.slice(0, tableWidth).map(header => [
              { type: "text", text: { content: header || "" } }
            ])
          }
        });
        
        // 데이터 행들
        rows.forEach(row => {
          tableChildren.push({
            type: "table_row",
            table_row: {
              cells: Array(tableWidth).fill(0).map((_, idx) => [
                { type: "text", text: { content: row[idx] || "" } }
              ])
            }
          });
        });
        
        blocks.push({
          type: "table",
          table: {
            table_width: tableWidth,
            has_column_header: true,
            has_row_header: false,
            children: tableChildren
          }
        });
      }
      continue;
    }

    // 4️⃣ 체크리스트 처리
    if (/^[-*]\s+\[([ x])\]\s+/.test(line)) {
      const isChecked = line.includes("[x]");
      const text = line.replace(/^[-*]\s+\[([ x])\]\s+/, "");
      blocks.push({
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: text } }],
          checked: isChecked
        }
      });
      i++;
      continue;
    }

    // 5️⃣ 번호 리스트 처리
    if (/^\d+\.\s+/.test(line)) {
      blocks.push({
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [{ type: "text", text: { content: line.replace(/^\d+\.\s+/, "") } }]
        }
      });
      i++;
      continue;
    }

    // 6️⃣ 불릿 리스트 처리
    if (/^[-*]\s+/.test(line)) {
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: line.replace(/^[-*]\s+/, "") } }]
        }
      });
      i++;
      continue;
    }

    // 7️⃣ 인용문 처리
    if (line.startsWith("> ")) {
      blocks.push({
        type: "quote",
        quote: {
          rich_text: [{ type: "text", text: { content: line.slice(2) } }]
        }
      });
      i++;
      continue;
    }

    // 8️⃣ 구분선 처리
    if (line.trim() === "---" || line.trim() === "***") {
      blocks.push({
        type: "divider",
        divider: {}
      });
      i++;
      continue;
    }

    // 9️⃣ 기본 문단 처리
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: line } }] }
    });
    i++;
  }

  return blocks.length
    ? blocks.slice(0, 100)
    : [{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "" } }] } }];
}

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

// DB 속성 자동 매핑 (Select 전용 status, Multi-select 전용 tags)
function makePropertyMapper(dbProps) {
  const entries = Object.entries(dbProps || {});
  const byType = (t) => entries.filter(([_, v]) => v?.type === t);
  const findByNames = (cands) => {
    const set = new Set(cands.map(normalize));
    const found = entries.find(([k]) => set.has(normalize(k)));
    return found ? found[0] : null;
  };

  const NAME_CANDS = ["name", "title", "제목", "타이틀"];
  const URL_CANDS = ["url", "link", "주소"];
  const DATE_CANDS = ["date", "날짜"];
  const TAGS_CANDS = ["tags", "tag", "태그"];
  const STATUS_CANDS = ["status", "state", "상태"];

  const titleKey = findByNames(NAME_CANDS) || (byType("title")[0]?.[0] || null);
  const urlKey = findByNames(URL_CANDS) || (byType("url")[0]?.[0] || null);
  const dateKey = findByNames(DATE_CANDS) || (byType("date")[0]?.[0] || null);
  const tagsKey =
    findByNames(TAGS_CANDS) ||
    (byType("multi_select")[0]?.[0] || null); // 태그는 multi_select 우선
  // status는 "선택(Select)" 타입만 사용
  const statusKeyByName = findByNames(STATUS_CANDS);
  const statusKey =
    (statusKeyByName && dbProps[statusKeyByName]?.type === "select" && statusKeyByName) ||
    (byType("select")[0]?.[0] || null);

  return { titleKey, urlKey, dateKey, tagsKey, statusKey };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Charset");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_PAGE_ID } = process.env;
  if (!NOTION_TOKEN) return res.status(500).json({ error: "Missing NOTION_TOKEN env" });

  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);
  const { mode, title, content, url, date, tags, status, pageId: overridePageId } = body || {};
  const m = String(mode || "").trim().toLowerCase();
  if (!m || !["db", "page", "both"].includes(m)) {
    return res.status(400).json({ error: "Missing 'mode' (db | page | both)" });
  }

  const results = {};
  try {
    // -------- DB 저장 (db / both) --------
    if (m === "db" || m === "both") {
      const dbId = toUuid(body?.databaseId || NOTION_DATABASE_ID || "");
      if (!dbId) return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env (db/both)" });

      const finalTitle = deriveTitle(title, content);
      const db = await notion.databases.retrieve({ database_id: dbId });
      const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
      if (!titleKey) return res.status(400).json({ error: "No title property in DB" });

      const properties = {};
      properties[titleKey] = { title: [{ type: "text", text: { content: String(finalTitle) } }] };
      if (url && urlKey) properties[urlKey] = { url: String(url) };
      if (date && dateKey) properties[dateKey] = { date: { start: String(date) } };
      if (Array.isArray(tags) && tags.length && tagsKey) {
        properties[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
      }
      // status는 Select 타입 전용. 값이 있으면 넣고, 없으면 무시.
      if (status && statusKey) {
        properties[statusKey] = { select: { name: String(status) } }; // 없는 옵션이면 Notion이 자동 생성
      }

      const dbPage = await notion.pages.create({ parent: { database_id: dbId }, properties });
      if (content) {
        await notion.blocks.children.append({ block_id: dbPage.id, children: toBlocks(content) });
      }
      results.db = dbPage.id;
    }

    // -------- 하위 페이지 생성 + 블록 추가 (page / both) --------
    if (m === "page" || m === "both") {
      const parentPageId = toUuid(overridePageId || NOTION_PAGE_ID || "");
      if (!parentPageId) return res.status(500).json({ error: "Missing NOTION_PAGE_ID env or pageId in body (page/both)" });

      const finalTitle = deriveTitle(title, content);
      const newPage = await notion.pages.create({
        parent: { page_id: parentPageId },
        properties: {
          title: { title: [{ type: "text", text: { content: String(finalTitle) } }] },
        },
      });
      if (content) {
        await notion.blocks.children.append({ block_id: newPage.id, children: toBlocks(content) });
      }
      results.page = newPage.id;
    }

    return res.status(200).json({ ok: true, mode: m, results });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const statusCode = err?.status || err?.response?.status || 500;
    return res.status(statusCode).json({
      error: "Failed to save to Notion",
      detail: err?.response?.data || err?.message || "Unknown",
    });
  }
};