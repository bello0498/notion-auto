// api/privacy.js
module.exports = (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html>
    <head><title>Privacy Policy</title></head>
    <body>
      <h1>개인정보 처리방침</h1>
      <p>이 GPT는 사용자 데이터를 저장하거나 분석하지 않습니다.<br />
         모든 입력은 OpenAI와 사용자의 Notion API에 직접 전달됩니다.<br />
      </p>
    </body>
    </html>
  `);
};
