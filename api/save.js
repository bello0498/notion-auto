// ----- handler -----
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "Missing NOTION_TOKEN env" });
  }

  const body = await readJSON(req);
  const { mode, title, content, url, date, tags, status, pageId } = body || {};

  const notion = new Client({ auth: NOTION_TOKEN });

  try {
    if (mode === "db") {
      if (!NOTION_DATABASE_ID) {
        return res.status(500).json({ error: "Missing NOTION_DATABASE_ID env" });
      }
      if (!title) {
        return res.status(400).json({ error: "Missing 'title' for DB mode" });
      }

      // DB 속성 조회 → 자동 매핑
      const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
      const { titleKey, urlKey, dateKey, tagsKey, statusKey } = makePropertyMapper(db?.properties || {});
      if (!titleKey) {
        return res.status(400).json({ error: "No title property in DB" });
      }

      const properties = {};
      properties[titleKey] = { title: [{ type: "text", text: { content: String(title) } }] };
      if (url && urlKey) properties[urlKey] = { url: String(url) };
      if (date && dateKey) properties[dateKey] = { date: { start: String(date) } };
      if (Array.isArray(tags) && tags.length && tagsKey) {
        properties[tagsKey] = { multi_select: tags.map((t) => ({ name: String(t) })) };
      }
      if (status && statusKey) {
        properties[statusKey] = { select: { name: String(status) } };
      }

      const page = await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties
      });

      if (content) {
        const children = toBlocks(content).slice(0, 100);
        await notion.blocks.children.append({ block_id: page.id, children });
      }

      return res.status(200).json({ ok: true, pageId: page.id, mode: "db" });
    }

    if (mode === "page") {
      if (!pageId) {
        return res.status(400).json({ error: "Missing 'pageId' for page mode" });
      }
      if (!content) {
        return res.status(400).json({ error: "Missing 'content' for page mode" });
      }

      const children = toBlocks(content).slice(0, 100);
      await notion.blocks.children.append({
        block_id: pageId,
        children
      });

      return res.status(200).json({ ok: true, pageId, mode: "page" });
    }

    return res.status(400).json({ error: "Invalid mode. Use 'db' or 'page'" });

  } catch (err) {
    console.error("Save API error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    const detail = err?.message || err?.response?.data || "Unknown error";
    return res.status(status).json({ error: "Failed to save to Notion", detail });
  }
};
