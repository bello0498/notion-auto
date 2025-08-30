# notion-auto

Vercel에서 실행되는 Notion 자동화 API입니다. 데이터베이스 페이지 생성, 하위 페이지 생성, 또는 둘 다 동시에 처리할 수 있습니다.

## 🚀 API 엔드포인트

```
POST https://notion-auto.vercel.app/api/save
```

## 📝 사용 방법

### 1. DB 모드 - 데이터베이스에 페이지 생성

```bash
curl -X POST "https://notion-auto.vercel.app/api/save" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "db",
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
  "mode": "db",
  "title": "디자인 리뷰 메모",
  "content": "# 회의 메모\n- 헤더 16px 그리드\n- 버튼 간격 8px",
  "url": "https://example.com/spec",
  "date": "2025-08-17",
  "tags": ["UI", "Review"],
  "status": "Open"
}
```

### 2. PAGE 모드 - 하위 페이지 생성

```bash
curl -X POST "https://notion-auto.vercel.app/api/save" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "page",
    "title": "퍼블 메모",
    "content": "## 오늘 작업\n- 카드 hover"
  }'
```

**JSON Body:**
```json
{
  "mode": "page",
  "title": "퍼블 메모",
  "content": "## 오늘 작업\n- 카드 hover"
}
```

### 3. BOTH 모드 - DB + 하위 페이지 동시 생성

```bash
curl -X POST "https://notion-auto.vercel.app/api/save" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "both",
    "title": "동시 저장 테스트",
    "content": "### 한 번에\n- DB + 하위페이지",
    "status": "Open"
  }'
```

**JSON Body:**
```json
{
  "mode": "both",
  "title": "동시 저장 테스트",
  "content": "### 한 번에\n- DB + 하위페이지",
  "status": "Open"
}
```

## 📋 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| `mode` | string | ✅ | `"db"`, `"page"`, `"both"` 중 하나 |
| `title` | string | ❌ | 페이지 제목 (미입력시 자동 생성) |
| `content` | string | ❌ | Markdown 형식 내용 |
| `url` | string | ❌ | 관련 URL (DB 모드에서만) |
| `date` | string | ❌ | 날짜 (YYYY-MM-DD 형식) |
| `tags` | array | ❌ | 태그 배열 (DB 모드에서만) |
| `status` | string | ❌ | 상태값 (DB 모드에서만) |
| `pageId` | string | ❌ | 특정 페이지 ID 지정 시 |

## 📊 응답 형식

### 성공 응답
```json
{
  "ok": true,
  "mode": "both",
  "results": {
    "db": "25f2bab5-2224-81e8-a6b6-effed4af4dc3",
    "page": "25f2bab5-2224-81d0-8ceb-f84da230d8f0"
  }
}
```

### 에러 응답
```json
{
  "error": "Failed to save to Notion",
  "detail": "상태 is expected to be status."
}
```

## 🔧 환경 변수 설정

Vercel 프로젝트에서 다음 환경 변수를 설정해주세요:

```env
NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # DB 모드용
NOTION_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx     # PAGE 모드용
```

## 🤖 OpenAPI & GPT Actions

### OpenAPI Schema
```
https://notion-auto.vercel.app/openapi.json
```

### GPT Actions 연동
1. ChatGPT → "Add actions" 
2. "Import from URL" 선택
3. 위 OpenAPI URL 붙여넣기

## 💡 팁

- **title 미입력시**: content 첫 줄 또는 타임스탬프로 자동 생성
- **Markdown 지원**: `# ## ###`, `- *` (리스트) 자동 변환
- **한국어 속성**: `제목`, `태그`, `상태` 등 한국어 속성명 자동 인식
- **최대 블록**: 100개 블록까지 처리

## 📱 사용 예시

### JavaScript/Node.js
```javascript
const response = await fetch('https://notion-auto.vercel.app/api/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    mode: 'db',
    title: '새 메모',
    content: '## 내용\n- 할일 1\n- 할일 2',
    tags: ['메모', '할일']
  })
});

const result = await response.json();
console.log(result);
```

### Python
```python
import requests

response = requests.post(
    'https://notion-auto.vercel.app/api/save',
    json={
        'mode': 'page',
        'title': '파이썬 메모',
        'content': '### 작업 목록\n- API 테스트\n- 문서 작성'
    }
)

print(response.json())
```

## 🔍 디버깅

문제가 있을 때 확인사항:
1. Notion DB의 속성명 확인 (제목, 상태, 태그 등)
2. status 값이 DB의 선택 옵션과 일치하는지 확인
3. 환경 변수가 올바르게 설정되었는지 확인

---

💬 **문의사항이나 이슈가 있으시면 GitHub Issues에 남겨주세요!**