// POST /api/admin/users/delete · Fase 2 PR-A
//
// Borra el doc del usuario y deshabilita su Firebase Auth account (reversible ·
// no hard-delete). Caller: masterAdmin o clinicAdmin de esa clínica.
//
// body: { clinicId: string, uid: string }
// 200: { ok: true }

import { assertAllowedOrigin } from "../../_lib/auth.js";
import { setCORS, handleOptions } from "../../_lib/cors.js";
import { getAdminDb } from "../../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../../_lib/jwt.js";
import { logSafeError } from "../../_lib/logSafe.js";
import { getAuth } from "firebase-admin/auth";

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  return null;
}

function authorizeCaller(req) {
  const claims = verifySession(bearerFromReq(req));
  if (!claims || !claims.role) return null;
  return { role: claims.role, clinicId: claims.clinicId ?? null };
}

export default async function handler(req, res) {
  setCORS(req, res, { methods: "POST, OPTIONS" });
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertAllowedOrigin(req, res)) return;

  const caller = authorizeCaller(req);
  if (!caller) return res.status(401).json({ error: "No autenticado" });

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  const clinicId = typeof body.clinicId === "string" ? body.clinicId.trim() : "";
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  if (!clinicId || !uid) return res.status(400).json({ error: "clinicId y uid requeridos" });

  // Authz.
  if (caller.role === "masterAdmin") {
    // ok
  } else if (caller.role === "clinicAdmin") {
    if (caller.clinicId !== clinicId) {
      return res.status(403).json({ error: "Solo podés gestionar usuarios de tu clínica" });
    }
  } else {
    return res.status(403).json({ error: "Acción no permitida para tu rol" });
  }

  try {
    const db = getAdminDb();
    await db.doc(`clinics/${clinicId}/users/${uid}`).delete();
    // Deshabilitar el Firebase Auth user (reversible · no hard-delete por seguridad).
    try {
      await getAuth().updateUser(uid, { disabled: true });
    } catch (e) {
      // user no existe en Firebase Auth (bcrypt-legacy sin migrar) · no es error.
      if (e?.code !== "auth/user-not-found") throw e;
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    logSafeError("admin/users/delete", e);
    return res.status(500).json({ error: "No se pudo eliminar el usuario" });
  }
}
