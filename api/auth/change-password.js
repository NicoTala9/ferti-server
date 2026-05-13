// POST /api/auth/change-password
// header: Authorization: Bearer <token>
// body: { currentPassword, newPassword }
// 200: { success: true }
// 400: { error: "<validation>" }
// 401: { error: "<credenciales|sesión inválida>" }
// 403: { error: "<rol no aplica|origen>" }
// 500: { error: "Cambio de contraseña falló" }
//
// SEC Sev 2-B (B2 · 2026-05-08): cierra el password change client-side plaintext
// (`me.password !== currentPassword` + `password: newPassword`) que persistía
// en las 4 apps. Ahora:
//   1. Verifica current password via bcrypt.compare contra `passwordHash`
//      (auto-migra desde plaintext legacy via verifyPassword `needsRehash` flag).
//   2. Hashea new password (bcrypt cost 12) y actualiza Firestore.
//   3. Actualiza `passwordUpdatedAt` + `profile.security.lastPasswordChange`
//      (audit trail · J.4.b CF puede leer + emitir notificación email futuro).
//   4. Limpia `password` plaintext field si quedaba legacy (one-shot migration).
//
// Auth: JWT Bearer · solo `role: "user"` (master/clinicAdmin tienen passwords
// hardcoded en env vars o `platformClinics.clinicAdminPasswordHash` · cambio
// vía runbook · no UI).
//
// /harden adversarial review (2026-05-08):
//   - CSRF: assertAllowedOrigin (origin allowlist · prod + previews + localhost).
//   - Brute force: Upstash sliding window 30/min/IP global (pre-existing rateLimit.js)
//     · NO per-user lock por simplicidad · bcrypt cost 12 ya impone ~250ms/intento
//     · adicional lock per-user TBD (post-Vercel-Pro · no bloqueador demo).
//   - Password strength: server-side validation (8+ chars · 1 uppercase · 1 digit)
//     · NO trust client validation (UI mostraba 6 chars min · server endurece a 8).
//   - User enumeration: 401 idéntico para "current wrong" vs "user no existe"
//     (mitigated también por bcrypt timing constante).
//   - Audit: passwordUpdatedAt timestamp · CF audit trail post-J.4.b puede ingest.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { hashPassword, verifyPassword } from "../_lib/password.js";
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
    return `La nueva contraseña debe tener al menos ${MIN_LEN} caracteres.`;
  }
  if (!HAS_UPPER.test(pwd)) {
    return "La nueva contraseña debe incluir al menos una letra mayúscula.";
  }
  if (!HAS_DIGIT.test(pwd)) {
    return "La nueva contraseña debe incluir al menos un número.";
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

  // Rate limit global (Upstash sliding 30/min/IP). Si Upstash no configurado,
  // no-op + warn (mismo pattern que login.js).
  const withinLimit = await assertWithinRateLimit(req, res);
  if (!withinLimit) return;

  // Auth: JWT Bearer obligatorio.
  const token = bearerFromReq(req);
  const session = verifySession(token);
  if (!session) {
    return res.status(401).json({ error: "Sesión inválida o expirada." });
  }
  if (session.role !== "user") {
    return res.status(403).json({
      error: "El cambio de contraseña no aplica a este rol. Contactá al administrador.",
    });
  }
  const userId = session.sub;
  const clinicId = session.clinicId;
  if (!userId || !clinicId) {
    return res.status(401).json({ error: "Sesión inválida (sin userId/clinicId)." });
  }

  // Body parse + size guard.
  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword y newPassword requeridos" });
  }
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return res.status(400).json({ error: strengthError });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({
      error: "La nueva contraseña debe ser distinta de la actual.",
    });
  }

  try {
    const db = getAdminDb();
    const ref = db.collection(`clinics/${clinicId}/users`).doc(userId);
    const snap = await ref.get();
    if (!snap.exists) {
      // Anti-enumeration: mismo 401 que current-password-wrong.
      return res.status(401).json({ error: "La contraseña actual no coincide." });
    }
    const u = snap.data();
    const stored = u.passwordHash || u.password || "";
    if (!stored) {
      return res.status(403).json({
        error: "Tu cuenta no tiene contraseña configurada · contactá al administrador.",
      });
    }
    const { match } = await verifyPassword(currentPassword, stored);
    if (!match) {
      return res.status(401).json({ error: "La contraseña actual no coincide." });
    }

    const newHash = await hashPassword(newPassword);
    const now = Date.now();
    const isoNow = new Date(now).toISOString();
    const update = {
      passwordHash: newHash,
      password: "", // limpiar plaintext legacy (one-shot migration en este path)
      passwordUpdatedAt: now,
    };
    // Actualizar también profile.security.lastPasswordChange si profile existe
    // (audit trail consistente con shape v2 · J.2.b).
    if (u.profile && typeof u.profile === "object" && u.profile.security && typeof u.profile.security === "object") {
      update["profile.security.lastPasswordChange"] = isoNow;
    }
    await ref.update(update);
    return res.status(200).json({ success: true });
  } catch (e) {
    logSafeError("auth/change-password", e);
    return res.status(500).json({ error: "Cambio de contraseña falló" });
  }
}
