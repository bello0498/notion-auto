// ==========================
// lib/toBlocks.js (final-fixed)
// ==========================

function toBlocks(raw = "") {
  const lines = String(raw).split("\n").map((l) => l.trimEnd());
  const blocks = [];
  let i = 0;

  const supportedLanguages = [
    "abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic", "bnf", "c", "c#",
    "c++", "clojure", "coffeescript", "coq", "css", "dart", "dhall", "diff", "docker", "ebnf", "elixir",
    "elm", "erlang", "f#", "flow", "fortran", "gherkin", "glsl", "go", "graphql", "groovy", "haskell",
    "hcl", "html", "idris", "java", "javascript", "json", "julia", "kotlin", "latex", "less", "lisp",
    "livescript", "llvm ir", "lua", "makefile", "markdown", "markup", "matlab", "mathematica",
    "mermaid", "nix", "notion formula", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
    "powershell", "prolog", "protobuf", "purescript", "python", "r", "racket", "reason", "ruby",
    "rust", "sass", "scala", "scheme", "scss", "shell", "smalltalk", "solidity", "sql", "swift",
    "toml", "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml"
  ];

  // ---------- helpers ----------
  const isBareUrl = (s) => /^(https?:\/\/\S+)$/i.test(s.trim());
  const extractFirstUrl = (s) => {
    const m = s.match(/https?:\/\/[^\s)]+/i); // 공백/닫는 괄호 전까지
    return m ? m[0] : null;
  };

  const isImageUrl = (u) => /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(u);
  const withHttps = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

  const isYouTube = (u) => /(youtube\.com|youtu\.be)/i.test(u);
  const isVimeo = (u) => /(vimeo\.com)/i.test(u);
  const isLoom = (u) => /(loom\.com)/i.test(u);
  const isFigma = (u) => /(figma\.com)/i.test(u);

  const normalizeYouTube = (u) => {
    try {
      const url = new URL(u);
      url.protocol = "https:";
      const host = url.hostname.replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = url.pathname.replace(/^\/+/, "");
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (host === "youtube.com" || host === "m.youtube.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] === "shorts" && parts[1]) {
          return `https://www.youtube.com/watch?v=${parts[1]}`;
        }
      }
      return url.toString();
    } catch {
      return u;
    }
  };

  const chooseBlockForUrl = (url) => {
    let u = withHttps(url.trim());
    if (isYouTube(u)) u = normalizeYouTube(u);

    if (isImageUrl(u)) {
      return { type: "image", payload: { type: "external", external: { url: u } } };
    }
    if (isYouTube(u) || isVimeo(u)) {
      return { type: "video", payload: { type: "external", external: { url: u } } };
    }
    if (isLoom(u) || isFigma(u)) {
      return { type: "embed", payload: { url: u } };
    }
    return { type: "embed", payload: { url: u } };
  };

  const pushVideo = (url) => blocks.push({ type: "video", video: { type: "external", external: { url } } });
  const pushEmbed = (url) => blocks.push({ type: "embed", embed: { url } });
  const pushImage = (url) => blocks.push({ type: "image", image: { type: "external", external: { url } } });

  // 리스트 항목 컨텐츠를 임베드로 승격할지 판단 (콘텐츠가 "패턴만" 있을 때만 승격)
  const promoteListContentIfSingle = (content) => {
    const c = content.trim();

    // 1) 명시 패턴: !!영상!!(URL)
    let m = c.match(/^!!영상!!\((.+?)\)$/);
    if (m) {
      let url = withHttps(m[1].trim());
      if (isYouTube(url)) url = normalizeYouTube(url);
      return { type: "video", obj: { type: "video", video: { type: "external", external: { url } } } };
    }

    // 2) 명시 패턴: !!임베드!!(URL)
    m = c.match(/^!!임베드!!\((.+?)\)$/);
    if (m) {
      let url = withHttps(m[1].trim());
      if (isYouTube(url)) {
        url = normalizeYouTube(url);
        return { type: "video", obj: { type: "video", video: { type: "external", external: { url } } } };
      }
      if (isVimeo(url)) return { type: "video", obj: { type: "video", video: { type: "external", external: { url } } } };
      if (isImageUrl(url)) return { type: "image", obj: { type: "image", image: { type: "external", external: { url } } } };
      if (isLoom(url) || isFigma(url)) return { type: "embed", obj: { type: "embed", embed: { url } } };
      return { type: "embed", obj: { type: "embed", embed: { url } } };
    }

    // 3) 명시 패턴: !!파일!!(URL)
    m = c.match(/^!!파일!!\((.+?)\)$/);
    if (m) {
      const url = m[1].trim();
      return { type: "file", obj: { type: "file", file: { type: "external", external: { url } } } };
    }

    // 4) 마크다운 이미지
    m = c.match(/^!\[.*?\]\((.+?)\)$/);
    if (m) {
      const url = m[1].trim();
      return { type: "image", obj: { type: "image", image: { type: "external", external: { url } } } };
    }

    // 5) URL 단독
    if (isBareUrl(c)) {
      const { type, payload } = chooseBlockForUrl(c);
      if (type === "video") return { type, obj: { type, video: payload } };
      if (type === "image") return { type, obj: { type, image: payload } };
      return { type, obj: { type, embed: payload } };
    }

    return null; // 승격 안 함
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    // 빈 줄 무시
    if (!t) { i++; continue; }

    // 헤딩
    if (line.startsWith("### ")) { blocks.push({ type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] } }); i++; continue; }
    if (line.startsWith("## ")) { blocks.push({ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] } }); i++; continue; }
    if (line.startsWith("# ")) { blocks.push({ type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] } }); i++; continue; }

    // 코드 블록
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().toLowerCase();
      const safeLanguage = supportedLanguages.includes(language) ? language : "plain text";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      blocks.push({ type: "code", code: { rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }], language: safeLanguage } });
      i++; continue;
    }

    // 테이블 (마크다운)
    if (line.includes("|") && lines[i + 1]?.includes("|") && lines[i + 1].includes("-")) {
      const tableLines = [line]; i += 2;
      while (i < lines.length && lines[i].includes("|")) { tableLines.push(lines[i]); i++; }
      const parseTableRow = (row) => row.split("|").map((c) => c.trim()).filter(Boolean);
      const headers = parseTableRow(tableLines[0]);
      const rows = tableLines.slice(1).map(parseTableRow);
      const tableWidth = Math.max(headers.length, ...rows.map((r) => r.length));
      // children 네스팅은 허용되지만, API 제약 있는 워크스페이스면 append로 따로 넣어야 할 수 있음.
      const children = [
        { type: "table_row", table_row: { cells: headers.slice(0, tableWidth).map((h) => [{ type: "text", text: { content: h || "" } }]) } },
        ...rows.map((row) => ({ type: "table_row", table_row: { cells: Array(tableWidth).fill(0).map((_, i) => [{ type: "text", text: { content: row[i] || "" } }]) } }))
      ];
      blocks.push({ type: "table", table: { table_width: tableWidth, has_column_header: true, has_row_header: false, children } });
      continue;
    }

    // 체크리스트
    if (/^[-*]\s+\[([ x])\]\s+/.test(t)) {
      const isChecked = /\[x\]/i.test(t);
      const text = t.replace(/^[-*]\s+\[([ x])\]\s+/, "");
      blocks.push({ type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: text } }], checked: isChecked } });
      i++; continue;
    }

    // 번호 리스트 — 패턴/URL 단독이면 승격
    if (/^\d+\.\s+/.test(t)) {
      const content = t.replace(/^\d+\.\s+/, "");
      const promoted = promoteListContentIfSingle(content);
      if (promoted) {
        blocks.push(promoted.obj);
      } else {
        blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: [{ type: "text", text: { content } }] } });
      }
      i++; continue;
    }

    // 불릿 리스트 — 패턴/URL 단독이면 승격
    if (/^[-*]\s+/.test(t)) {
      const content = t.replace(/^[-*]\s+/, "");
      const promoted = promoteListContentIfSingle(content);
      if (promoted) {
        blocks.push(promoted.obj);
      } else {
        blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content } }] } });
      }
      i++; continue;
    }

    // 인용문
    if (t.startsWith("> ")) { blocks.push({ type: "quote", quote: { rich_text: [{ type: "text", text: { content: t.slice(2) } }] } }); i++; continue; }

    // 구분선
    if (t === "---" || t === "***") { blocks.push({ type: "divider", divider: {} }); i++; continue; }

    // 콜아웃
    if (t.startsWith("> 📌")) {
      blocks.push({ type: "callout", callout: { icon: { type: "emoji", emoji: "📌" }, rich_text: [{ type: "text", text: { content: t.slice(4).trim() } }], color: "default" } });
      i++; continue;
    }

    // 토글
    if (t.startsWith("!! ")) {
      const content = t.slice(3).trim();
      blocks.push({ type: "toggle", toggle: { rich_text: [{ type: "text", text: { content } }], children: [] } });
      i++; continue;
    }

    // 동기화 블록
    if (t === "/sync") {
      const children = []; i++;
      while (i < lines.length && lines[i].trim() !== "/endsync") {
        children.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: lines[i] } }] } });
        i++;
      }
      blocks.push({ type: "synced_block", synced_block: { synced_from: null, children } });
      i++; continue;
    }

    // 이미지 (마크다운, 라인 전체일 때)
    {
      const m = t.match(/^!\[.*?\]\((.+?)\)$/);
      if (m) { pushImage(m[1]); i++; continue; }
    }

    // 영상 (명시적) — 라인 전체일 때
    {
      const m = t.match(/^!!영상!!\((.+?)\)$/);
      if (m) {
        let url = withHttps(m[1].trim());
        if (isYouTube(url)) url = normalizeYouTube(url);
        pushVideo(url);
        i++; continue;
      }
    }

    // 파일 (명시적) — 라인 전체일 때
    {
      const m = t.match(/^!!파일!!\((.+?)\)$/);
      if (m) {
        const url = m[1].trim();
        blocks.push({ type: "file", file: { type: "external", external: { url } } });
        i++; continue;
      }
    }

    // 북마크
    {
      const m = t.match(/^<(.+?)>$/);
      if (m) { blocks.push({ type: "bookmark", bookmark: { url: m[1].trim() } }); i++; continue; }
    }

    // 목차
    if (t === "[목차]") { blocks.push({ type: "table_of_contents", table_of_contents: {} }); i++; continue; }

    // 임베드 (명시적) — 라인 전체일 때
    {
      const m = t.match(/^!!임베드!!\((.+?)\)$/);
      if (m) {
        let url = withHttps(m[1].trim());
        if (isYouTube(url)) { url = normalizeYouTube(url); pushVideo(url); }
        else if (isVimeo(url)) { pushVideo(url); }
        else if (isImageUrl(url)) { pushImage(url); }
        else if (isLoom(url) || isFigma(url)) { pushEmbed(url); }
        else { pushEmbed(url); }
        i++; continue;
      }
    }

    // (개선) 라인 자체가 “URL 하나만”이면 승격
    if (isBareUrl(t)) {
      const { type, payload } = chooseBlockForUrl(t);
      if (type === "video") blocks.push({ type, video: payload });
      else if (type === "image") blocks.push({ type, image: payload });
      else blocks.push({ type, embed: payload });
      i++; continue;
    }

    // 기본 문단
    blocks.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line } }] } });
    i++;
  }

  return blocks.length ? blocks.slice(0, 100) : [
    { type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "" } }] } }
  ];
}

module.exports = { toBlocks };
