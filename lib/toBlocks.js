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

  while (i < lines.length) {
    const line = lines[i];

    // 빈 줄 무시
    if (!line.trim()) {
      i++;
      continue;
    }

    // 헤딩 블록
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] } });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] } });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] } });
      i++;
      continue;
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
      i++;
      continue;
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
    if (/^[-*]\s+\[([ x])\]\s+/.test(line)) {
      const isChecked = line.includes("[x]");
      const text = line.replace(/^[-*]\s+\[([ x])\]\s+/, "");
      blocks.push({ type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: text } }], checked: isChecked } });
      i++;
      continue;
    }

    // 리스트 (번호, 불릿)
    if (/^\d+\.\s+/.test(line)) {
      blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: [{ type: "text", text: { content: line.replace(/^\d+\.\s+/, "") } }] } });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.replace(/^[-*]\s+/, "") } }] } });
      i++;
      continue;
    }

    // 인용문
    if (line.startsWith("> ")) {
      blocks.push({ type: "quote", quote: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] } });
      i++;
      continue;
    }

    // 구분선
    if (line.trim() === "---" || line.trim() === "***") {
      blocks.push({ type: "divider", divider: {} });
      i++;
      continue;
    }

    // 콜아웃
    if (line.startsWith("> 📌")) {
      blocks.push({ type: "callout", callout: { icon: { type: "emoji", emoji: "📌" }, rich_text: [{ type: "text", text: { content: line.slice(4).trim() } }], color: "default" } });
      i++;
      continue;
    }

    // 토글
    if (line.startsWith("!! ")) {
      const content = line.slice(3).trim();
      blocks.push({ type: "toggle", toggle: { rich_text: [{ type: "text", text: { content } }], children: [] } });
      i++;
      continue;
    }

    // 동기화 블록
    if (line === "/sync") {
      const children = [];
      i++;
      while (i < lines.length && lines[i] !== "/endsync") {
        children.push({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: lines[i] } }] } });
        i++;
      }
      blocks.push({ type: "synced_block", synced_block: { synced_from: null, children } });
      i++;
      continue;
    }

    // 이미지
    const imageMatch = line.match(/!\[.*?\]\((.*?)\)/);
    if (imageMatch) {
      blocks.push({ type: "image", image: { type: "external", external: { url: imageMatch[1] } } });
      i++;
      continue;
    }

    // 영상
    if (line.startsWith("!!영상!!(") && line.endsWith(")")) {
      const url = line.slice(7, -1);
      blocks.push({ type: "video", video: { type: "external", external: { url } } });
      i++;
      continue;
    }

    // 파일
    if (line.startsWith("!!파일!!(") && line.endsWith(")")) {
      const url = line.slice(7, -1);
      blocks.push({ type: "file", file: { type: "external", external: { url } } });
      i++;
      continue;
    }

    // 북마크
    const bookmarkMatch = line.match(/^<(.+?)>$/);
    if (bookmarkMatch) {
      blocks.push({ type: "bookmark", bookmark: { url: bookmarkMatch[1] } });
      i++;
      continue;
    }

    // 목차
    if (line.trim() === "[목차]") {
      blocks.push({ type: "table_of_contents", table_of_contents: {} });
      i++;
      continue;
    }

    // 임베드
    if (line.startsWith("!!임베드!!(") && line.endsWith(")")) {
      const url = line.slice(9, -1);
      blocks.push({ type: "embed", embed: { url } });
      i++;
      continue;
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
