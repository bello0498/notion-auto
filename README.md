# notion-auto

Vercel에서 실행되는 Notion 및 Confluence 자동화 API입니다. Notion DB에 페이지를 생성하고, 필요한 경우 Confluence에도 문서를 함께 생성할 수 있습니다.

---

## 🚀 API 엔드포인트

```
POST https://notion-auto.vercel.app/api/save
POST https://notion-auto.vercel.app/api/gptConfluence
```

---

## 📝 Notion 저장 (Always DB 저장 방식)

### ✅ 기본 사용 예시

```bash
curl -X POST "https://notion-auto.vercel.app/api/save" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "디자인 리뷰 메모",
    "content": "# 회의 메모\n- 헤더 16px 그리드\n- 버튼 간격 8px",
    "url": "https://example.com/spec",
    "date": "2025-08-17",
    "tags": ["UI", "Review"],
    "status": "Open"
  }'
```

**JSON Body:**

```json
{
  "title": "디자인 리뷰 메모",
  "content": "# 회의 메모\n- 헤더 16px 그리드\n- 버튼 간격 8px",
  "url": "https://example.com/spec",
  "date": "2025-08-17",
  "tags": ["UI", "Review"],
  "status": "Open"
}
```

---

## 🧾 Confluence 문서 생성

### ✅ 기본 사용 예시

```bash
curl -X POST "https://notion-auto.vercel.app/api/gptConfluence" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "퍼블리싱 가이드",
    "content": "<h2>버튼 컴포넌트</h2><ul><li>Primary: #0055FF</li></ul>",
    "tags": ["디자인 시스템", "가이드"],
    "status": "작성중",
    "date": "2025-09-06"
  }'
```

**JSON Body:**

```json
{
  "title": "퍼블리싱 가이드",
  "content": "<h2>버튼 컴포넌트</h2><ul><li>Primary: #0055FF</li></ul>",
  "tags": ["디자인 시스템", "가이드"],
  "status": "작성중",
  "date": "2025-09-06"
}
```

---

## 📋 파라미터 설명 (공통)

| 파라미터         | 타입     | 필수 | 설명                               |
| ------------ | ------ | -- | -------------------------------- |
| `title`      | string | ✅  | 제목                               |
| `content`    | string | ✅  | 본문 내용 (Markdown 또는 HTML)         |
| `tags`       | array  | ❌  | 태그 배열 (multi\_select 또는 Label)   |
| `status`     | string | ❌  | 상태값 (Select 또는 Page Properties)  |
| `date`       | string | ❌  | 생성일 (YYYY-MM-DD 또는 ISO datetime) |
| `url`        | string | ❌  | 관련 링크 (Notion에서만 사용)             |
| `pageId`     | string | ❌  | 기존 페이지 수정용 (Notion 전용)           |
| `databaseId` | string | ❌  | Notion DB override (환경변수 대신 사용)  |

---

## 📊 응답 예시

### ✅ Notion 저장 성공 시

```json
{
  "ok": true,
  "results": {
    "db": "25f2bab5-2224-81e8-a6b6-effed4af4dc3",
    "url": "https://www.notion.so/xxxxxxxxxxxx"
  }
}
```

### ✅ Confluence 저장 성공 시

```json
{
  "ok": true,
  "id": "123456",
  "links": {
    "webui": "https://aegisep.atlassian.net/wiki/spaces/SPACEKEY/pages/123456"
  }
}
```

---

## 🔧 환경 변수 설정 (Vercel)

```env
NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

CONFLUENCE_EMAIL=example@domain.com
CONFLUENCE_API_TOKEN=your_confluence_api_token
CONFLUENCE_DOMAIN=https://your-domain.atlassian.net/wiki
CONFLUENCE_SPACE_KEY=SPACEKEY
CONFLUENCE_PARENT_PAGE_ID=0000000
```

---

## 📌 기능 요약 및 팁

* Notion 저장은 항상 Database를 기준으로 저장됨
* `pageId`가 있으면 기존 DB 아이템 블록만 수정
* `title`이 content에 중복될 경우 자동 제거 처리
* Confluence는 단순 생성만 지원 (수정 불가)
* Markdown (Notion), HTML (Confluence) 포맷 지원
* 한글 속성 자동 매핑 및 최대 100개 블록까지 지원

---

## 🧠 OpenAPI & GPT Actions 연동

```
https://notion-auto.vercel.app/openapi.json
```

1. ChatGPT → "Add actions"
2. "Import from URL" 선택
3. 위 OpenAPI URL 입력 후 연결

---

## 📱 사용 예시 (Node.js & Python)

### Node.js

```js
const response = await fetch('https://notion-auto.vercel.app/api/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '새 메모',
    content: '# 작업내용\n- 컴포넌트 수정',
    tags: ['메모', '개발']
  })
});
const result = await response.json();
console.log(result);
```

### Python

```python
import requests

response = requests.post(
    'https://notion-auto.vercel.app/api/gptConfluence',
    json={
        'title': 'Confluence 문서',
        'content': '<h1>문서 생성</h1><p>테스트</p>',
        'tags': ['DevOps'],
        'status': '초안'
    }
)
print(response.json())
```

---

💬 문의사항은 GitHub Issues 또는 ChatGPT를 통해 언제든지 주세요!
