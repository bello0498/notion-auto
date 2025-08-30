const { Client } = require("@notionhq/client");

// UUID 보정
const toUuid = (id = "") =>
  /^[0-9a-fA-F]{32}$/.test(id)
    ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
    : id;

function toBlocks(raw = "") {
  const lines = String(raw).split("\n").map(l => l.trimEnd());
  return lines.filter(Boolean).map(line => {
    if (line.startsWith("### ")) return { type: "heading_3", heading_3: { rich_text: [{ text: { content: line.slice(4) } }] } };
    if (line.startsWith("## "))  return { type: "heading_2", heading_2: { rich_text: [{ text: { content: line.slice(3) } }] } };
    if (line.startsWith("# "))   return { type: "heading_1", heading_1: { rich_text: [{ text: { content: line.slice(2) } }] } };
    if (/^[-*]\s+/.test(line))   return { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: line.replace(/^[-*]\s+/, "") } }] } };
    return { type: "paragraph", paragraph: { rich_text: [{ text: { content: line } }] } };
  });
}

async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_PAGE_ID } = process.env;
  const notion = new Client({ auth: NOTION_TOKEN });
  const body = await readJSON(req);
  const { mode, title, content } = body;

  try {
    let results = {};

    // DB 저장
    if (mode === "db" || mode === "both") {
      if (!title) return res.status(400).json({ error: "Missing 'title' for DB mode" });
      const dbId = toUuid(NOTION_DATABASE_ID);
      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          제목: { title: [{ text: { content: title } }] }
        }
      });
      if (content) {
        await notion.blocks.children.append({
          block_id: page.id,
          children: toBlocks(content)
        });
      }
      results.db = page.id;
    }
    
    // 페이지 저장
    if (mode === "page" || mode === "both") {
      const pageId = toUuid(body?.pageId || NOTION_PAGE_ID);
      if (!content) return res.status(400).json({ error: "Missing 'content' for page mode" });

      // 1) 하위 페이지를 생성하고 싶을 경우
      const newPageTitle = body?.title || "자동 생성된 하위 페이지";
      const child = {
        object: "block",
        type: "child_page",
        child_page: { title: newPageTitle }
      };

      // 2) 하위 페이지를 부모에 추가
      const resp = await notion.blocks.children.append({
        block_id: pageId,
        children: [child]
      });

      results.page = resp;
    }


    return res.status(200).json({ ok: true, mode, results });
  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    return res.status(err?.status || 500).json({ error: err.message || "Unknown error" });
  }
};
