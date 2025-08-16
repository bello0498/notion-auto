module.exports = (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Only POST" });
  let body = req.body;
  // 만약 Vercel이 파싱 안 했을 때 대비
  if (!body) {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { body = JSON.parse(data || "{}"); } catch { body = {}; }
      return res.status(200).json({ ok: true, echo: body });
    });
    return;
  }
  return res.status(200).json({ ok: true, echo: body });
};
