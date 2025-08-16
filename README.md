# notion-auto-save (Vercel)

서버 URL 예: `https://<your-project>.vercel.app/api/save`

### POST Body (JSON)
```json
{
  "title": "디자인 리뷰 메모",
  "content": "# 회의 메모\n- 헤더 16px 그리드\n- 버튼 간격 8px",
  "url": "https://example.com/spec",
  "date": "2025-08-17",
  "tags": ["UI","Review"],
  "status": "Open"
}