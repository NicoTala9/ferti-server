// POST /api/admin/users/grant-training-permission · Fase 1 Training multi-tenant
//
// Master-only. Setea un sub-permiso de training en el doc del user:
//   clinics/{clinicId}/users/{uid}.permissions.{appKey}.training.{key} = value
//
// Por qué en el doc (no en custom claims):
//   - Los claims los pisa /api/admin/users/upsert con setCustomUserClaims (replace).
//   - Las rules TARGET leen el flag con get() del doc → surte efecto sin re-login.
//   - Forma de permisos uniforme cross-app (appKey: oocyte|sperm|blastocyst).
//
// body: { clinicId: string, uid: string, appKey: string, key: string, value: boolean }
// 200: { ok: true }
// 404: usuario inexistente · 403: no master · 400: body inválido

import { assertAllowedOrigin } from "../../_lib/auth.js";
import { setCORS, handleOptions } from "../../_lib/cors.js";
import { getAdminDb } from "../../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../../_lib/jwt.js";
import { assertWithinRateLimit } from "../../_lib/rateLimit.js";
import { logSafeError } from "../../_lib/logSafe.js";
import { FieldValue } from "firebase-admin/firestore";

const MAX_BODY_BYTES = 4 * 1024;
const ALLOWED_APP_KEYS = new Set(["oocyte", "sperm", "blastocyst"]);
const ALLOWED_KEYS = new Set(["upload", "download_own"]);

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
  if (!(await assertWithinRateLimit(req, res))) return;

  // Authz: master only. Asignar permisos cross-clínica es capability de plataforma.
  const claims = verifySession(bearerFromReq(req));
  if (!claims || !claims.role) return res.status(401).json({ error: "No autenticado" });
  if (claims.role !== "masterAdmin") {
    return res.status(403).json({ error: "Solo el Master Admin puede asignar permisos de training" });
  }

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const clinicId = typeof body.clinicId === "string" ? body.clinicId.trim() : "";
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const appKey = typeof body.appKey === "string" ? body.appKey.trim() : "";
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const value = body.value;

  if (!clinicId) return res.status(400).json({ error: "clinicId requerido" });
  if (!uid) return res.status(400).json({ error: "uid requerido" });
  if (!ALLOWED_APP_KEYS.has(appKey)) return res.status(400).json({ error: "appKey inválido" });
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: "key inválido" });
  if (typeof value !== "boolean") return res.status(400).json({ error: "value debe ser boolean" });

  try {
    const db = getAdminDb();
    const docRef = db.doc(`clinics/${clinicId}/users/${uid}`);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Usuario no encontrado" });

    // set + merge deep-mergea el map · preserva otros appKeys/keys de permissions.
    await docRef.set(
      {
        permissions: { [appKey]: { training: { [key]: value } } },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    logSafeError("admin/users/grant-training-permission", e);
    return res.status(500).json({ error: "No se pudo guardar el permiso" });
  }
}
