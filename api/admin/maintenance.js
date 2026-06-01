// POST /api/admin/maintenance · Update strategy Parte 2 · Fase 2.2
//
// Prende/apaga el maintenance mode (hard block). Escribe el singleton
// platformConfig/maintenance vía Admin SDK (bypassa rules · verifica JWT
// masterAdmin server-side). El cliente LO LEE directo de Firestore (read público
// del doc · ver firestore.rules platformConfig/maintenance) para el splash y el
// panel · este endpoint es SOLO escritura.
//
// SOLO master. Mismo patrón que /api/admin/clinics/archive.
//
// PATCH parcial · escribe SOLO los campos presentes en el body (merge):
//   active      — prende (true) / apaga (false) el bloqueo HARD (splash).
//   message     — texto del splash (cap 500).
//   until       — timestamp ms del countdown del splash · null = sin fecha.
//   softUntil   — Parte 3 (soft) · timestamp ms del pre-aviso non-blocking ·
//                 null = cancelar el aviso.
//   softMessage — texto del banner de pre-aviso (cap 500).
// Requiere al menos `active` o `softUntil` para considerarse un cambio válido.
// 200: { ok: true, maintenance: {patch} } · 400: body inválido · 403: no master

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../_lib/jwt.js";
import { logSafeError } from "../_lib/logSafe.js";

const MAINTENANCE_DOC = "platformConfig/maintenance";
const MESSAGE_MAX = 500;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

export default async function handler(req, res) {
  setCORS(req, res, { methods: "POST, OPTIONS" });
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertAllowedOrigin(req, res)) return;

  const claims = verifySession(bearerFromReq(req));
  if (!claims || claims.role !== "masterAdmin") {
    return res.status(403).json({ error: "Solo el Master puede cambiar el modo mantenimiento" });
  }

  const body = readBody(req);
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Body inválido" });
  }

  const validTs = (v) => (Number.isFinite(v) && v > 0 ? v : null);

  // PATCH parcial · solo los campos presentes en el body se escriben (merge).
  const patch = {
    updatedAt: Date.now(),
    updatedBy: claims.username || claims.id || "master",
  };
  let meaningful = false;

  if (typeof body.active === "boolean") { patch.active = body.active; meaningful = true; }
  if (typeof body.message === "string") patch.message = body.message.trim().slice(0, MESSAGE_MAX);
  if ("until" in body) patch.until = validTs(body.until);
  if ("softUntil" in body) { patch.softUntil = validTs(body.softUntil); meaningful = true; }
  if (typeof body.softMessage === "string") patch.softMessage = body.softMessage.trim().slice(0, MESSAGE_MAX);

  if (!meaningful) {
    return res.status(400).json({ error: "Nada para actualizar · enviá `active` o `softUntil`" });
  }

  try {
    const db = getAdminDb();
    // merge:true · crea el doc si no existe (no requiere seed previo).
    await db.doc(MAINTENANCE_DOC).set(patch, { merge: true });
    return res.status(200).json({ ok: true, maintenance: patch });
  } catch (e) {
    logSafeError("admin/maintenance", e);
    return res.status(500).json({ error: "No se pudo actualizar el modo mantenimiento" });
  }
}
