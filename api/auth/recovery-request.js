// POST /api/auth/recovery-request
// body: { email }
// 200: { ok: true }                              // siempre, anti enumeración
// 429: { error: "rate-limited", retryAt }        // rate limit hit
// 400: { error: "invalid-email" }
//
// Fase J.1.b · Brief Fase J §J.1.b · decisión §5.1 owner Set B (Resend).
//
// Flow:
//   1. Cliente POST email.
//   2. Server resuelve userType (master | clinicAdmin) lookup en Firestore.
//   3. Genera 6-digit code · TTL 15min · escribe doc en passwordRecoveryTokens.
//   4. Envía email Resend con template tenant-aware.
//   5. Responde 200 always (anti email enumeration).
//
// Feature flag: RECOVERY_ENABLED env var (default false). Sin él, request loga
// y responde 200 sin enviar email · permite deploy aditivo sin Resend cuenta.
//
// Rate limit: 3 requests/hora/email · Firestore counter (rateLimits/recovery_{emailHash}).

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { isValidEmail } from "../_lib/validation.js";
import { logSafeError } from "../_lib/logSafe.js";
import {
  createRecoveryToken,
  checkRecoveryRateLimit,
} from "../_lib/recoveryTokens.js";
import { sendEmail } from "../_lib/resendClient.js";
import { recoveryMasterEmail } from "../../templates/recoveryMaster.js";
import { recoveryClinicAdminEmail } from "../../templates/recoveryClinicAdmin.js";

const MAX_BODY_BYTES = 4 * 1024;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

/**
 * Resuelve el userType del email vía Firestore lookup.
 * Para J.1, master + clinicAdmin (decisión D1 90 días bcrypt fallback · users
 * básicos no soportados todavía).
 *
 * @returns {Promise<{ userType: "master"|"clinicAdmin", uid: string|null, clinicName: string|null }|null>}
 */
async function resolveUserType(db, email) {
  const norm = email.trim().toLowerCase();
  // Master · check masterAdmins collection (post J.1.a) o env var FERTI_MASTER_EMAIL (legacy).
  const masterEmail = (process.env.FERTI_MASTER_EMAIL || "").trim().toLowerCase();
  if (masterEmail && norm === masterEmail) {
    return { userType: "master", uid: null, clinicName: null };
  }
  const masterSnap = await db.collection("masterAdmins").where("email", "==", norm).limit(1).get();
  if (!masterSnap.empty) {
    return { userType: "master", uid: masterSnap.docs[0].id, clinicName: null };
  }
  // ClinicAdmin · check platformClinics.clinicAdminEmail (post J.1.a) o legacy username field.
  const clinicSnap = await db
    .collection("platformClinics")
    .where("clinicAdminEmail", "==", norm)
    .limit(1)
    .get();
  if (!clinicSnap.empty) {
    const doc = clinicSnap.docs[0];
    return {
      userType: "clinicAdmin",
      uid: doc.data()?.clinicAdminUid || null,
      clinicName: doc.data()?.name || doc.id,
    };
  }

  // Post-migración Firebase Auth (PR-B): clinicAdmins y usuarios normales viven en
  // clinics/{cid}/users con `email` + doc id == uid. Buscamos por email iterando
  // platformClinics (mismo patrón que /api/auth/login · evita índice collectionGroup).
  // Esto habilita recovery para TODOS los roles, no solo master/clinicAdmin.
  const clinicsSnap = await db.collection("platformClinics").get();
  for (const c of clinicsSnap.docs) {
    const us = await db
      .collection(`clinics/${c.id}/users`)
      .where("email", "==", norm)
      .limit(1)
      .get();
    if (!us.empty) {
      const d = us.docs[0];
      const role = d.data()?.role === "clinicAdmin" ? "clinicAdmin" : "user";
      return { userType: role, uid: d.id, clinicName: c.data()?.name || c.id };
    }
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

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Invalid body" });
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid-email" });
  }

  try {
    const db = getAdminDb();

    // Rate limit pre-lookup (anti enumeration timing).
    const rl = await checkRecoveryRateLimit(db, email);
    if (!rl.allowed) {
      return res.status(429).json({ error: "rate-limited", retryAt: rl.resetAt });
    }

    const resolved = await resolveUserType(db, email);

    // Anti enumeration: respondemos 200 always · solo enviamos si user existe.
    if (!resolved) {
      console.warn("[auth/recovery-request] email no encontrado:", email.slice(0, 3) + "...");
      return res.status(200).json({ ok: true });
    }

    const { code } = await createRecoveryToken(db, {
      email,
      userType: resolved.userType,
      uid: resolved.uid,
    });

    const tpl = resolved.userType === "master"
      ? recoveryMasterEmail({ code })
      : recoveryClinicAdminEmail({ code, clinicName: resolved.clinicName });

    const result = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html });
    if (!result.delivered) {
      // Loguear pero responder 200 igualmente · si Resend está down, el user ve
      // "Si el email existe te enviamos un código" y reintenta.
      console.warn("[auth/recovery-request] email no enviado · reason:", result.reason);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    logSafeError("auth/recovery-request", e);
    return res.status(500).json({ error: "Recovery failed" });
  }
}
