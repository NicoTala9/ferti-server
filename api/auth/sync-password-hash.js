// POST /api/auth/sync-password-hash · defense in depth post-changePassword
//
// CONTEXTO: el cliente cambia su pass via Firebase Auth path (session.js
// changePassword · signInWithEmailAndPassword + updatePassword). Eso actualiza
// la pass REAL en Firebase Auth, pero NO sincroniza el hash legacy de Firestore:
//   - role:"clinicAdmin" → platformClinics/{cid}.clinicAdminPasswordHash
//   - role:"user"        → clinics/{cid}/users/{uid}.passwordHash
//
// Si ese hash queda stale, divergencia: el path dynamic STEP 3 (login.js) podría
// validar contra el hash viejo si alguien intenta loguear con la pass vieja. Es
// defense in depth · ya hoy el path principal de prod es Firebase Auth, pero
// mantener los hashes sincronizados elimina la superficie de ataque.
//
// header: Authorization: Bearer <token>
// body: { newPassword: string }
// 200: { success: true } (también para masterAdmin · no-op)
// 400 / 401 / 403 / 500 según el caso.
//
// SECURITY:
//   - Requiere JWT válido. Si alguien con JWT robado llama esto, lo único que
//     puede hacer es desincronizar SU PROPIO hash · no escalar privilegios.
//   - El JWT robado YA da acceso a la sesión activa · esto no agrega vector
//     de ataque relevante.
//   - newPassword se valida strength (8+ · 1 upper · 1 digit) igual que el
//     endpoint legacy /change-password.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { hashPassword } from "../_lib/password.js";
import { verifySession, bearerFromReq } from "../_lib/jwt.js";
import { logSafeError } from "../_lib/logSafe.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";

const MIN_LEN = 8;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
const MAX_BODY_BYTES = 4 * 1024;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function validatePasswordStrength(pwd) {
  if (typeof pwd !== "string" || pwd.length < MIN_LEN) {
    return `La contraseña debe tener al menos ${MIN_LEN} caracteres.`;
  }
  if (!HAS_UPPER.test(pwd)) return "La contraseña debe incluir al menos una letra mayúscula.";
  if (!HAS_DIGIT.test(pwd)) return "La contraseña debe incluir al menos un número.";
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

  // Rate limit (mismo pattern que change-password.js).
  const withinLimit = await assertWithinRateLimit(req, res);
  if (!withinLimit) return;

  const token = bearerFromReq(req);
  const session = verifySession(token);
  if (!session) return res.status(401).json({ error: "Sesión inválida o expirada." });

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return res.status(400).json({ error: strengthError });

  // masterAdmin: no-op silencioso · el master no tiene hash legacy en Firestore
  // (vive en env var server-side · ver login.js buildMasterUser).
  if (session.role === "masterAdmin") {
    return res.status(200).json({ success: true, skipped: "masterAdmin has no Firestore hash" });
  }

  if (session.role !== "clinicAdmin" && session.role !== "user") {
    return res.status(403).json({ error: "Rol no soportado." });
  }

  const userId = session.sub;
  const clinicId = session.clinicId;
  if (!clinicId) return res.status(401).json({ error: "Sesión sin clinicId." });
  if (session.role === "user" && !userId) {
    return res.status(401).json({ error: "Sesión sin userId." });
  }

  try {
    const db = getAdminDb();
    const newHash = await hashPassword(newPassword);
    const now = Date.now();

    if (session.role === "clinicAdmin") {
      // Sync a platformClinics/{cid}.clinicAdminPasswordHash.
      await db.doc(`platformClinics/${clinicId}`).update({
        clinicAdminPasswordHash: newHash,
        clinicAdminPasswordUpdatedAt: now,
      });
    } else {
      // role: "user" · sync a clinics/{cid}/users/{uid}.passwordHash.
      await db.doc(`clinics/${clinicId}/users/${userId}`).update({
        passwordHash: newHash,
        password: "", // limpiar plaintext legacy si quedaba (one-shot)
        passwordUpdatedAt: now,
      });
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    logSafeError("auth/sync-password-hash", e);
    return res.status(500).json({ error: "No se pudo sincronizar el hash" });
  }
}
