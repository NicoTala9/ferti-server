// POST /api/admin/clinics/purge · Pata 3 Fase 2 (HARD delete · IRREVERSIBLE)
//
// Borra DEFINITIVAMENTE una clínica + TODA su data:
//   1. Auth users (clinicAdmin + todos los `clinics/{cid}/users/*` con uid).
//   2. Cascade delete de `clinics/{clinicId}/*` (recursiveDelete: patients, cycles,
//      analyses, users, deleted, medications, etc.).
//   3. El doc `platformClinics/{clinicId}`.
//
// SOLO master. Pre-condición server-side: la clínica DEBE estar archivada
// (status:"inactive") para forzar el 2-step archive → purge (matchea el patrón UX).
// Sin special-cases por clínica (post-CEGYR-as-normal · 2026-05-28).
//
// Confirmación fuerte: el body debe traer `confirmClinicId` que matchee `clinicId`.
//
// body: { clinicId: string, confirmClinicId: string }
// 200: { ok: true, deletedAuthUsers: N }
// 400 / 403 / 404 / 409 según el caso.

import { assertAllowedOrigin } from "../../_lib/auth.js";
import { setCORS, handleOptions } from "../../_lib/cors.js";
import { getAdminDb } from "../../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../../_lib/jwt.js";
import { logSafeError } from "../../_lib/logSafe.js";
import { getFirestore } from "firebase-admin/firestore";
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
    return res.status(403).json({ error: "Solo el Master puede purgar clínicas" });
  }

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  const clinicId = typeof body.clinicId === "string" ? body.clinicId.trim() : "";
  const confirmClinicId = typeof body.confirmClinicId === "string" ? body.confirmClinicId.trim() : "";
  if (!clinicId) return res.status(400).json({ error: "clinicId requerido" });
  if (confirmClinicId !== clinicId) {
    return res.status(400).json({ error: "confirmClinicId no coincide con clinicId" });
  }

  try {
    const db = getAdminDb();
    const clinicRef = db.doc(`platformClinics/${clinicId}`);
    const snap = await clinicRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Clínica no encontrada" });

    const clinicData = snap.data();
    // Pre-condición UX 2-step: debe estar archivada.
    if (clinicData.status !== "inactive") {
      return res.status(409).json({
        error: "La clínica debe estar archivada antes de purgar (archive → purge)",
      });
    }

    // ─── 1) Recolectar Auth UIDs a borrar ──────────────────────────────────
    const uidsToDelete = new Set();
    if (clinicData.clinicAdminUid) uidsToDelete.add(clinicData.clinicAdminUid);
    try {
      const usersSnap = await db.collection(`clinics/${clinicId}/users`).get();
      for (const u of usersSnap.docs) {
        const uid = u.data()?.uid;
        if (uid && typeof uid === "string") uidsToDelete.add(uid);
      }
    } catch (e) {
      // Subcolección puede no existir si la clínica nunca tuvo users · OK.
      console.warn("[purge] reading users for", clinicId, ":", e?.message);
    }

    // ─── 2) Borrar Auth users (best-effort por uid · no aborta si alguno falla) ───
    let deletedAuthUsers = 0;
    for (const uid of uidsToDelete) {
      try {
        await getAuth().deleteUser(uid);
        deletedAuthUsers++;
      } catch (e) {
        if (e?.code !== "auth/user-not-found") {
          console.warn("[purge] deleteUser", uid, ":", e?.message);
        }
      }
    }

    // ─── 3) recursiveDelete sobre clinics/{cid}/* ──────────────────────────
    // firestore.recursiveDelete(ref) borra la subcollection completa (todos los
    // docs + sus subcollections). El "phantom parent" clinics/{cid} no tiene fields
    // propios (todo vive en subcollections per modelo de datos), pero recursiveDelete
    // sobre la docRef se encarga de descender por TODAS las subcollections.
    try {
      await getFirestore().recursiveDelete(db.doc(`clinics/${clinicId}`));
    } catch (e) {
      // Logueamos pero seguimos a borrar el doc platformClinics igual · el master
      // puede re-correr el purge si quedó algo de data y reportar.
      console.warn("[purge] recursiveDelete clinics/", clinicId, ":", e?.message);
    }

    // ─── 4) Borrar el doc platformClinics ──────────────────────────────────
    await clinicRef.delete();

    return res.status(200).json({ ok: true, deletedAuthUsers });
  } catch (e) {
    logSafeError("admin/clinics/purge", e);
    return res.status(500).json({ error: "No se pudo purgar la clínica" });
  }
}
