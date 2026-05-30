// POST /api/admin/users/upsert · Fase 2 PR-A
//
// Crea o actualiza un usuario de clínica vía Admin SDK:
//   1. Verifica al CALLER (JWT propio · masterAdmin o clinicAdmin de esa clínica).
//   2. Resuelve/crea el Firebase Auth user (email/password) → uid.
//   3. Escribe `clinics/{clinicId}/users/{uid}` (id del doc == uid · clave para que
//      la Cloud Function setClinicMemberClaims setee los custom claims role+clinicId).
//   4. Best-effort: invite por email (no-op si RECOVERY_ENABLED=false).
//
// Por qué server-side (no escritura directa del cliente):
//   - Crea el Firebase Auth user (necesario para el uid y para cerrar las rules TARGET).
//   - El password nunca toca Firestore (lo gestiona Firebase Auth).
//   - Guard server-side authoritative contra escalada de rol (no confiar en la UI).
//
// Coexistencia (PR-A · aditivo): nada del cliente llama a este endpoint todavía.
// El rewiring de buildAdminServices se hace en el cutover (PR-C).
//
// body: {
//   clinicId: string,
//   user: { id?, email, displayName?, username?, role?: "user"|"clinicAdmin",
//           permissions?, active?, isDoctor? },
//   password?: string,        // opcional · si falta, se genera temporal + invite
//   sendInvite?: boolean      // default true si no hay password
// }
// 200: { ok: true, uid, created: boolean, invite: { delivered, reason? } }

import { assertAllowedOrigin } from "../../_lib/auth.js";
import { setCORS, handleOptions } from "../../_lib/cors.js";
import { getAdminDb } from "../../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../../_lib/jwt.js";
import { sendEmail } from "../../_lib/resendClient.js";
import { logSafeError } from "../../_lib/logSafe.js";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";

const MAX_BODY_BYTES = 16 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Roles que este endpoint puede asignar. masterAdmin NUNCA se crea acá.
const ASSIGNABLE_ROLES = new Set(["user", "clinicAdmin"]);

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

// Caller authz: devuelve { role, clinicId } o null.
function authorizeCaller(req) {
  const claims = verifySession(bearerFromReq(req));
  if (!claims || !claims.role) return null;
  return { role: claims.role, clinicId: claims.clinicId ?? null };
}

function randomTempPassword() {
  // 24 chars · suficiente entropía · el user lo resetea vía recovery.
  return `Tmp-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
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
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const clinicId = typeof body.clinicId === "string" ? body.clinicId.trim() : "";
  const u = body.user && typeof body.user === "object" ? body.user : null;
  if (!clinicId) return res.status(400).json({ error: "clinicId requerido" });
  if (!u) return res.status(400).json({ error: "user requerido" });

  const email = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "email inválido" });

  // Rol destino · default "user". clinicAdmin solo lo puede crear el master.
  const targetRole = ASSIGNABLE_ROLES.has(u.role) ? u.role : "user";

  // --- Authz: quién puede tocar qué ---
  if (caller.role === "masterAdmin") {
    // master puede todo
  } else if (caller.role === "clinicAdmin") {
    if (caller.clinicId !== clinicId) {
      return res.status(403).json({ error: "Solo podés gestionar usuarios de tu clínica" });
    }
    if (targetRole !== "user") {
      return res.status(403).json({ error: "Un admin de clínica solo puede crear usuarios normales" });
    }
  } else {
    return res.status(403).json({ error: "Acción no permitida para tu rol" });
  }

  try {
    // getAdminDb() hace initializeApp() · DEBE ir antes de getAuth() o en cold
    // start getAuth() tira app/no-app → 500 (mismo bug latente que J.1.a en
    // firebase-login.js · commit e501ad3).
    const db = getAdminDb();
    const auth = getAuth();

    // 1. Resolver/crear Firebase Auth user por email.
    let fbUser = null;
    let created = false;
    try {
      fbUser = await auth.getUserByEmail(email);
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
    }
    const password = typeof body.password === "string" && body.password.length >= 8
      ? body.password
      : null;

    if (!fbUser) {
      fbUser = await auth.createUser({
        email,
        password: password || randomTempPassword(),
        displayName: u.displayName || undefined,
        emailVerified: false,
        disabled: u.active === false,
      });
      created = true;
    } else if (password) {
      // update de password explícito (admin reseteó).
      await auth.updateUser(fbUser.uid, { password });
    }
    const uid = fbUser.uid;

    // 2. Escribir doc clinics/{clinicId}/users/{uid} · merge · sin password.
    //    El id del doc ES el uid (precondición de setClinicMemberClaims + rules TARGET).
    const docRef = db.doc(`clinics/${clinicId}/users/${uid}`);
    const existing = (await docRef.get()).data() || {};
    const next = {
      ...existing,
      uid,
      email,
      role: targetRole,
      clinicId,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (u.displayName !== undefined) next.displayName = u.displayName;
    if (u.username !== undefined) next.username = u.username;
    if (u.permissions !== undefined) next.permissions = u.permissions;
    if (u.active !== undefined) next.active = u.active !== false;
    if (u.isDoctor !== undefined) next.isDoctor = !!u.isDoctor;
    if (created && next.createdAt === undefined) next.createdAt = FieldValue.serverTimestamp();
    // NUNCA persistir password en Firestore.
    delete next.password;
    await docRef.set(next, { merge: true });

    // 2b. Custom claims (role + clinicId) seteados DIRECTO acá · self-contained,
    //     no depende del deploy de los Cloud Functions. Sin esto, el user nuevo no
    //     podría acceder a su clínica bajo las rules TARGET (request.auth.token.*).
    //     setCustomUserClaims sobreescribe todos los claims → seteamos el set completo.
    await auth.setCustomUserClaims(uid, { role: targetRole, clinicId });

    // 3. Invite best-effort (no-op si RECOVERY_ENABLED=false · no bloquea el upsert).
    let invite = { delivered: false, reason: "skipped" };
    const wantsInvite = body.sendInvite !== false && !password;
    if (created && wantsInvite) {
      try {
        invite = await sendEmail({
          to: email,
          subject: "Tu acceso a Ferti IA Suite",
          html: `<p>Se creó tu cuenta en Ferti IA Suite.</p>
                 <p>Ingresá con tu email <strong>${email}</strong> y, si no tenés contraseña,
                 usá la opción "¿Olvidaste tu contraseña?" en la pantalla de login para definirla.</p>`,
        });
      } catch (e) {
        logSafeError("admin/users/upsert·invite", e);
        invite = { delivered: false, reason: "invite-error" };
      }
    }

    return res.status(200).json({ ok: true, uid, created, invite });
  } catch (e) {
    logSafeError("admin/users/upsert", e);
    if (e?.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Ese email ya está en uso" });
    }
    return res.status(500).json({ error: "No se pudo guardar el usuario" });
  }
}
