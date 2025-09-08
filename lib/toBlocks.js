// ==========================
// lib/toBlocks.js
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
  const isYouTube = (u) => /(youtube\.com|youtu\.be)/i.test(u);
  const normalizeYouTube = (u) => {
    try {
      const url = new URL(u);
      url.protocol = "https:";
      const host = url.hostname.replace(/^www\./, "");
      // youtu.be/<id> → youtube.com/watch?v=<id>
      if (host === "youtu.be") {
        const id = url.pathname.replace(/^\/+/, "");
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
      // youtube.com/shorts/<id> → youtube.com/watch?v=<id>
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

  const pushVideo = (url) => {
    blocks.push({
      type: "video",
      video: { type: "external", external: { url } }
    });
  };

  const pushEmbed = (url) => {
    blocks.push({ type: "embed", embed: { url } });
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim(); // <-- 핵심: 들여쓰기 무시하고 패턴 매칭

    // 빈 줄 무시
    if (!t) { i++; continue; }

    // 헤딩 블록 (헤딩은 들여쓰기 무시하지 않음이 일반적이지만, 필요시 t로 바꿔도 됨)
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] } });
      i++; continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] } });
      i++; continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] } });
      i++; continue;
    }

    // 코드 블록
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().toLowerCase();
      const safeLanguage = supportedLanguages.includes(language) ? language : "plain text";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }],
          language: safeLanguage
        }
      });
      i++; continue;
    }

    // 테이블 블록
    if (line.includes("|") && lines[i + 1]?.includes("|") && lines[i + 1].includes("-")) {
      const tableLines = [line];
      i += 2;
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const parseTableRow = (row) => row.split("|").map((c) => c.trim()).filter(Boolean);
      const headers = parseTableRow(tableLines[0]);
      const rows = tableLines.slice(1).map(parseTableRow);
      const tableWidth = Math.max(headers.length, ...rows.map((r) => r.length));
      const children = [
        {
          type: "table_row",
          table_row: {
            cells: headers.slice(0, tableWidth).map((h) => [{ type: "text", text: { content: h || "" } }])
          }
        },
        ...rows.map((row) => ({
          type: "table_row",
          table_row: {
            cells: Array(tableWidth).fill(0).map((_, i) => [{ type: "text", text: { content: row[i] || "" } }])
          }
        }))
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

    // 리스트 (번호, 불릿) — 들여쓰기 허용
    if (/^\d+\.\s+/.test(t)) {
      blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: [{ type: "text", text: { content: t.replace(/^\d+\.\s+/, "") } }] } });
      i++; continue;
    }
    if (/^[-*]\s+/.test(t)) {
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: t.replace(/^[-*]\s+/, "") } }] } });
      i++; continue;
    }

    // 인용문
    if (t.startsWith("> ")) {
      blocks.push({ type: "quote", quote: { rich_text: [{ type: "text", text: { content: t.slice(2) } }] } });
      i++; continue;
    }

    // 구분선
    if (t === "---" || t === "***") {
      blocks.push({ type: "divider", divider: {} });
      i++; continue;
    }

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
      const children = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "/endsync") {
        children.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: lines[i] } }] } });
        i++;
      }
      blocks.push({ type: "synced_block", synced_block: { synced_from: null, children } });
      i++; continue;
    }

    // 이미지 (마크다운)
    const imageMatch = t.match(/!\[.*?\]\((.*?)\)/);
    if (imageMatch) {
      blocks.push({ type: "image", image: { type: "external", external: { url: imageMatch[1] } } });
      i++; continue;
    }

    // 영상 (명시적) — 들여쓰기 허용
    if (t.startsWith("!!영상!!(") && t.endsWith(")")) {
      let url = t.slice(7, -1).trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (isYouTube(url)) url = normalizeYouTube(url);
      pushVideo(url);
      i++; continue;
    }

    // 파일 (명시적) — 들여쓰기 허용
    if (t.startsWith("!!파일!!(") && t.endsWith(")")) {
      const url = t.slice(7, -1).trim();
      blocks.push({ type: "file", file: { type: "external", external: { url } } });
      i++; continue;
    }

    // 북마크
    const bookmarkMatch = t.match(/^<(.+?)>$/);
    if (bookmarkMatch) {
      blocks.push({ type: "bookmark", bookmark: { url: bookmarkMatch[1].trim() } });
      i++; continue;
    }

    // 목차
    if (t === "[목차]") {
      blocks.push({ type: "table_of_contents", table_of_contents: {} });
      i++; continue;
    }

    // 임베드 (명시적) — 유튜브면 video로 승격, 들여쓰기 허용
    if (t.startsWith("!!임베드!!(") && t.endsWith(")")) {
      let url = t.slice(9, -1).trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (isYouTube(url)) {
        url = normalizeYouTube(url);
        pushVideo(url);
      } else {
        pushEmbed(url);
      }
      i++; continue;
    }

    // (개선) 단독 URL 라인 — 들여쓰기 허용
    if (isBareUrl(t)) {
      let url = t;
      if (isYouTube(url)) {
        url = normalizeYouTube(url);
        pushVideo(url);
      } else {
        pushEmbed(url);
      }
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
