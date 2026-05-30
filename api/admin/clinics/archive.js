// POST /api/admin/clinics/archive · Pata 3 Fase 1 (soft archive/unarchive)
//
// Archive (soft, REVERSIBLE): status: "inactive" + disable Firebase Auth user
// del clinicAdmin → la clínica queda inactiva (usuarios no entran) pero data
// preservada. Reversible vía mismo endpoint con `restore: true`.
//
// SOLO master. La operación destructiva irreversible (Purge: borra doc + cascade
// clinics/{cid}/*) es endpoint separado · Pata 3 Fase 2.
//
// body: { clinicId: string, restore?: boolean }
// 200: { ok: true, status: "inactive" | "active" }
// 403: { error } · 404: { error: "Clínica no encontrada" }

import { assertAllowedOrigin } from "../../_lib/auth.js";
import { setCORS, handleOptions } from "../../_lib/cors.js";
import { getAdminDb } from "../../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../../_lib/jwt.js";
import { logSafeError } from "../../_lib/logSafe.js";
import { getAuth } from "firebase-admin/auth";

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
    return res.status(403).json({ error: "Solo el Master puede archivar clínicas" });
  }

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  const clinicId = typeof body.clinicId === "string" ? body.clinicId.trim() : "";
  if (!clinicId) return res.status(400).json({ error: "clinicId requerido" });
  const restore = body.restore === true;

  try {
    const db = getAdminDb();
    const ref = db.doc(`platformClinics/${clinicId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Clínica no encontrada" });

    const clinicAdminUid = snap.data().clinicAdminUid || null;
    const newStatus = restore ? "active" : "inactive";

    // Patch del doc: status + metadata de auditoría (archivedAt/By, null en restore).
    await ref.update({
      status: newStatus,
      archivedAt: restore ? null : Date.now(),
      archivedBy: restore ? null : (claims.username || claims.id || "master"),
    });

    // Espejo en Firebase Auth: deshabilita/rehabilita la cuenta del clinicAdmin
    // (sus users normales NO se tocan acá · viven en clinics/{cid}/users · se ven
    // afectados por las rules al cambiar status, no por flag disabled).
    if (clinicAdminUid) {
      try {
        await getAuth().updateUser(clinicAdminUid, { disabled: !restore });
      } catch (e) {
        if (e?.code !== "auth/user-not-found") throw e;
      }
    }
    return res.status(200).json({ ok: true, status: newStatus });
  } catch (e) {
    logSafeError("admin/clinics/archive", e);
    return res.status(500).json({ error: "No se pudo archivar/restaurar la clínica" });
  }
}
