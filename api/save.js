// Vercel Serverless Function (CommonJS)
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// 간단 변환: 문자열 → Notion block
function toBlocks(text) {
  return [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: text } }]
      }
    }
  ];
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID" });
  }

  try {
    const { mode, title, content, pageId } = req.body || {};

    // 1) DB 저장 모드
    if (mode === "db") {
      if (!title) return res.status(400).json({ error: "Missing title for DB save" });

      const page = await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: String(title) } }] },
          ...(content && {
            내용: { rich_text: [{ text: { content: String(content) } }] }
          })
        }
      });

      return res.status(200).json({ ok: true, mode: "db", pageId: page.id });
    }

    // 2) 페이지 저장 모드
    if (mode === "page") {
      if (!pageId || !content) {
        return res.status(400).json({ error: "Missing pageId or content for Page save" });
      }

      await notion.blocks.children.append({
        block_id: pageId,
        children: toBlocks(String(content))
      });

      return res.status(200).json({ ok: true, mode: "page", pageId });
    }

    return res.status(400).json({ error: "Invalid mode. Use 'db' or 'page'." });
  } catch (err) {
    console.error(err);
    const status = err?.status || 500;
    res.status(status).json({ error: "Failed to save to Notion", detail: err.message });
  }
};
