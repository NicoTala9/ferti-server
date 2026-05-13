// POST /api/auth/recovery-confirm
// body: { email, code, newPassword }
// 200: { ok: true }
// 400: { error: "invalid-email" | "invalid-code" | "weak-password" }
// 401: { error: "token-not-found" | "token-expired" | "token-used" }
//
// Fase J.1.b · valida 6-digit code + TTL · usa Firebase Admin SDK updateUser
// para setear nueva password.
//
// Marca el token como `used: true` en transacción · anti replay.
//
// Para masters/clinicAdmins migrados a Firebase Auth (J.1.a · uid !== null),
// updateUser({ uid, password }) actualiza el auth backend.
// Para users bcrypt-legacy (uid === null), updateUser de Firestore
// platformClinics.clinicAdminPasswordHash con bcrypt hash · 90-day fallback.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { isValidEmail } from "../_lib/validation.js";
import { logSafeError } from "../_lib/logSafe.js";
import { validateRecoveryToken } from "../_lib/recoveryTokens.js";
import { hashPassword } from "../_lib/password.js";
import { getAuth } from "firebase-admin/auth";

const MAX_BODY_BYTES = 4 * 1024;
const MIN_PASSWORD_LENGTH = 10;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function isValidCode(code) {
  return typeof code === "string" && /^\d{6}$/.test(code);
}

function isValidPassword(pwd) {
  return typeof pwd === "string" && pwd.length >= MIN_PASSWORD_LENGTH;
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
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!isValidEmail(email)) return res.status(400).json({ error: "invalid-email" });
  if (!isValidCode(code)) return res.status(400).json({ error: "invalid-code" });
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: "weak-password", minLength: MIN_PASSWORD_LENGTH });
  }

  try {
    const db = getAdminDb();
    const validation = await validateRecoveryToken(db, { email, code });
    if (!validation.valid) {
      const status = validation.reason === "expired" ? 401 : 401;
      return res.status(status).json({ error: `token-${validation.reason}` });
    }

    const tokenDoc = validation.doc;

    // Update password en transacción · marca token como used.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(tokenDoc.ref);
      if (!snap.exists || snap.data().used) {
        throw new Error("token-already-used");
      }
      tx.update(tokenDoc.ref, { used: true, usedAt: Date.now() });
    });

    // Path A: user migrado Firebase Auth (J.1.a) · updateUser con uid.
    if (tokenDoc.uid) {
      try {
        await getAuth().updateUser(tokenDoc.uid, { password: newPassword });
      } catch (e) {
        // Si updateUser falla post-token-used, el user puede re-solicitar recovery
        // (pierde 1 de 3 rate-limit attempts pero no bloquea).
        logSafeError("auth/recovery-confirm:firebase-update", e);
        return res.status(500).json({ error: "Update failed" });
      }
    } else {
      // Path B: user bcrypt-legacy (90-day fallback · J.1.a coexistence).
      // Hash + escribir en platformClinics.clinicAdminPasswordHash o
      // FERTI_MASTER_PASSWORD_HASH env var (master · update vía Vercel manual).
      const hash = await hashPassword(newPassword);
      if (tokenDoc.userType === "clinicAdmin") {
        // Update platformClinics.clinicAdminPasswordHash · query por email.
        const clinicSnap = await db
          .collection("platformClinics")
          .where("clinicAdminEmail", "==", email.toLowerCase())
          .limit(1)
          .get();
        if (clinicSnap.empty) {
          return res.status(500).json({ error: "Clinic not found" });
        }
        await clinicSnap.docs[0].ref.update({
          clinicAdminPasswordHash: hash,
          clinicAdminPassword: "",
          clinicAdminPasswordUpdatedAt: Date.now(),
        });
      } else {
        // userType === "master" · master env vars no se actualizan via API.
        // Master debe migrar a Firebase Auth (J.1.a) o owner edita FERTI_MASTER_PASSWORD_HASH manualmente.
        return res.status(409).json({
          error: "master-bcrypt-not-supported",
          detail: "Master debe migrar a Firebase Auth para usar recovery.",
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    logSafeError("auth/recovery-confirm", e);
    return res.status(500).json({ error: "Recovery failed" });
  }
}
