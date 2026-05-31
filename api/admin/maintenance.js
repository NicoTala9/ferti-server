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
// body: { active: boolean, message?: string, until?: number|null }
//   active  — prende (true) / apaga (false) el bloqueo.
//   message — texto opcional para el splash (cap 500 chars).
//   until   — timestamp ms opcional para countdown · null = sin fecha.
// 200: { ok: true, maintenance: {...} }
// 400: body inválido · 403: no master · 500: error

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
  if (!body || typeof body.active !== "boolean") {
    return res.status(400).json({ error: "Body inválido · `active` (boolean) requerido" });
  }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, MESSAGE_MAX) : "";
  const until = Number.isFinite(body.until) && body.until > 0 ? body.until : null;

  const payload = {
    active: body.active,
    message,
    until,
    updatedAt: Date.now(),
    updatedBy: claims.username || claims.id || "master",
  };

  try {
    const db = getAdminDb();
    // merge:true · crea el doc si no existe (no requiere seed previo).
    await db.doc(MAINTENANCE_DOC).set(payload, { merge: true });
    return res.status(200).json({ ok: true, maintenance: payload });
  } catch (e) {
    logSafeError("admin/maintenance", e);
    return res.status(500).json({ error: "No se pudo actualizar el modo mantenimiento" });
  }
}
