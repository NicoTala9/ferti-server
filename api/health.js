export default function handler(req, res) {
  res.status(200).json({ status: "ok", server: "ferti-server", modules: ["oocyte", "sperm"], timestamp: new Date().toISOString() });
}
