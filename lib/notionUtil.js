// ==========================
// lib/notionUtil.js
// ==========================

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function toUuid(id = "") {
  return /^[0-9a-fA-F]{32}$/.test(id)
    ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
    : id;
}

function deriveTitle(title, content) {
  const t = String(title || "").trim();
  if (t) return t;
  const firstLine = String(content || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  if (firstLine) return firstLine.replace(/^#+\s*|^[-*]\s*/, "").slice(0, 80);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Auto Note ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function makePropertyMapper(dbProps) {
  const entries = Object.entries(dbProps || {});
  const byType = (t) => entries.filter(([_, v]) => v?.type === t);
  const findByNames = (cands) => {
    const set = new Set(cands.map(normalize));
    const found = entries.find(([k]) => set.has(normalize(k)));
    return found ? found[0] : null;
  };

  // title/url/date/tags/status
  const titleKey = findByNames(["name", "title", "제목", "타이틀"]) || (byType("title")[0]?.[0] || null);
  const urlKey   = findByNames(["url", "link", "주소"])           || (byType("url")[0]?.[0]   || null);
  const dateKey  = findByNames(["date", "날짜"])                  || (byType("date")[0]?.[0]  || null);
  const tagsKey  = findByNames(["tags", "tag", "태그"])           || (byType("multi_select")[0]?.[0] || null);

  const statusKeyByName = findByNames(["status", "state", "상태"]);
  const statusKey = (statusKeyByName && dbProps[statusKeyByName]?.type === "select" && statusKeyByName)
                  || (byType("select")[0]?.[0] || null);

  // page id/url (오타 포함 허용: pageld)
  const pageIdKey  = findByNames(["pageId", "page_id", "pid", "페이지id", "pageld"]);
  const pageUrlKey = findByNames(["pageUrl", "page_url", "purl", "페이지url"]);

  // content (rich_text)
  const contentKeyByName = findByNames(["content", "본문", "내용", "body", "text", "텍스트"]);
  const contentKey = (contentKeyByName && dbProps[contentKeyByName]?.type === "rich_text" && contentKeyByName)
                  || (byType("rich_text")[0]?.[0] || null);

  return {
    titleKey,
    urlKey,
    dateKey,
    tagsKey,
    statusKey,
    pageIdKey,
    pageUrlKey,
    contentKey,
  };
}

module.exports = {
  normalize,
  toUuid,
  deriveTitle,
  makePropertyMapper,
};
