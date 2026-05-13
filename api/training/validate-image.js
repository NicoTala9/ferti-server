// Mock server endpoint · Fase J.3.e.
//
// POST /api/training/validate-image · query `?mock=true` always returns valid:true.
// Body: { imageBase64, imageType, imageSize }.
// Response: { valid: bool, reason?: string }.
//
// J.4.b · Cloud Function `imageQualityValidator` reemplaza este endpoint con un
// validador AI real (Laplacian variance + Claude Vision content check). Mientras
// tanto el cliente (`ImageQualityValidator.jsx`) hace TODA la validación dura
// client-side · este endpoint solo confirma para no bloquear demos.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const isMock = String(req.query?.mock || "").toLowerCase() === "true";

  // Validación mínima del body (defensive · evita 500s en demo).
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Si imagen ausente · responder valid:false en modo no-mock.
  if (!body.imageBase64 && !isMock) {
    res.status(400).json({ valid: false, reason: "imageBase64 ausente." });
    return;
  }

  // Tamaño guard cross-check (10 MB hard limit · cliente ya valida).
  if (typeof body.imageSize === "number" && body.imageSize > 10 * 1024 * 1024 && !isMock) {
    res.status(200).json({ valid: false, reason: "Imagen excede el límite de 10 MB." });
    return;
  }

  // Mock por default acepta todo · TODO J.4.c reemplaza con AI evaluator.
  res.status(200).json({
    valid: true,
    mock: isMock,
    note: "J.4.b live AI evaluator pendiente · este endpoint acepta todo por defecto.",
  });
}
