// POST /api/auth/login
// body: { username, password }
// 200: { user, token }
// 401: { error: "Invalid credentials" }
//
// SEC-005 / SEC-007 (audit P0, 2026-04-20): mueve auth al backend con bcrypt
// + JWT. Antes los passwords estaban plaintext en Firestore y las reglas
// del cliente los dejaban leer — un bug de rules era credenciales filtradas
// para toda la plataforma.
//
// Este endpoint replica la escalera del antiguo authUser() pero en el servidor.
// Para los roles modernos (masterAdmin) el login va por /api/auth/firebase-login;
// este endpoint solo cubre coexistencia bcrypt-legacy:
//   1. Dynamic Clinic Admins (platformClinics.clinicAdminPasswordHash) ← coexistencia
//   2. Usuarios normales (clinics/{cid}/users con prefijo "clinicId_username") ← coexistencia
//
// Auth modernization · post-CEGYR-as-normal:
//   - Scope B-c (4533432): removido el fast-path hardcoded CEGYR (env FERTI_CEGYR_*).
//   - MASTER (este commit): removido buildMasterUser + tryHardcodedAdmin · master
//     ahora loguea exclusivamente vía /api/auth/firebase-login · `masterAdmins/{uid}`
//     hidrata el user shape (clinicId:null + role:masterAdmin via custom claim).
//     Helper tryHardcodedAdmin queda obsoleto (sin callers) · removido.
//
// Las env vars FERTI_MASTER_* y FERTI_CEGYR_* quedan dead en Vercel (cleanup
// follow-up del owner).
//
// Los pasos 3 y 4 leen con firebase-admin (bypass de rules), así los passwords
// NO tienen que estar legibles desde el cliente. Las reglas de Firestore para
// cliente pueden cerrar users/ y platformClinics.*Password.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { hashPassword, verifyPassword } from "../_lib/password.js";
import { signSession } from "../_lib/jwt.js";
import { logSafeError } from "../_lib/logSafe.js";
import { checkLockout, recordFailedAttempt, clearAttempts, MAX_ATTEMPTS } from "../_lib/loginLockout.js";

const MAX_BODY_BYTES = 10 * 1024; // 10 KB. Un login no necesita más.

function readBody(req) {
  // Vercel ya parsea JSON si el content-type lo dice, pero por si viene crudo:
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

async function tryDynamicClinicAdmin(db, inputUsername, inputPassword) {
  const snap = await db.collection("platformClinics").get();
  for (const doc of snap.docs) {
    const c = doc.data();
    const uname = (c?.clinicAdminUsername || "").trim();
    if (uname !== inputUsername) continue;
    const stored = c?.clinicAdminPasswordHash || c?.clinicAdminPassword || "";
    if (!stored) continue;
    const { match, needsRehash } = await verifyPassword(inputPassword, stored);
    if (!match) continue;
    // Auto-migrar a hash si venía plaintext.
    if (needsRehash) {
      try {
        const hash = await hashPassword(inputPassword);
        await doc.ref.update({
          clinicAdminPasswordHash: hash,
          clinicAdminPassword: "",
          clinicAdminPasswordUpdatedAt: Date.now(),
        });
      } catch (e) {
        console.warn("[auth/login] failed to migrate clinicAdmin hash:", doc.id, e?.message);
      }
    }
    return {
      id: `__clinicadmin_${doc.id}__`,
      username: c.clinicAdminUsername,
      role: "clinicAdmin",
      displayName: c.clinicAdminDisplayName || `Admin ${c.name || doc.id}`,
      clinicId: doc.id,
      permissions: { analysis: true, portal: true, stats: true, training: true, admin: true },
    };
  }
  return null;
}

async function tryNormalUser(db, inputUsername, inputPassword) {
  // Usuarios están en `clinics/{cid}/users/{uid}` con `username` prefijado como
  // "cegyr_juana". Probamos contra cada clínica — no es costoso (hay pocas).
  //
  // Pre-demo fix 2026-05-07 (v1): aceptamos 3 formatos de input para tolerar
  // variaciones UX + datos legacy.
  //
  // Pre-demo fix 2026-05-08 (v2 · ROOT CAUSE Bug #2): iteramos `platformClinics`
  // en lugar de `clinics` porque firebase-admin SDK `.collection("clinics").get()`
  // NO retorna phantom parent docs (parents que solo existen via subcollections).
  // En este repo nadie escribe `clinics/{cid}` con fields, solo subcollections.
  // El query loop antes iteraba 0 veces · todos los normal users recibían 401.
  // `platformClinics` es la fuente de verdad de qué clínicas existen.
  const clinicsSnap = await db.collection("platformClinics").get();
  const lower = inputUsername.trim().toLowerCase();
  for (const cDoc of clinicsSnap.docs) {
    const cid = cDoc.id;
    const prefix = `${cid}_`;
    // Build candidates list · siempre 2 variants para max compatibility.
    // Pre-demo fix 2026-05-08 (v3): probar AMBOS formatos siempre · cubre case
    // de stored data legacy (sin prefix) cuando user tipea prefixed.
    const stripped = lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
    const candidates = [`${prefix}${stripped}`, stripped]; // ["cegyr_edu", "edu"]

    for (const candidate of candidates) {
      const usersSnap = await db.collection(`clinics/${cid}/users`)
        .where("username", "==", candidate)
        .limit(1)
        .get();
      if (usersSnap.empty) continue;
      const userDoc = usersSnap.docs[0];
      const u = userDoc.data();
      if (u.role !== "user") continue;
      const stored = u.passwordHash || u.password || "";
      if (!stored) continue;
      const { match, needsRehash } = await verifyPassword(inputPassword, stored);
      if (!match) continue;
      if (needsRehash) {
        try {
          const hash = await hashPassword(inputPassword);
          await userDoc.ref.update({
            passwordHash: hash,
            password: "",
            passwordUpdatedAt: Date.now(),
          });
        } catch (e) {
          console.warn("[auth/login] failed to migrate user hash:", userDoc.id, e?.message);
        }
      }
      return {
        id: userDoc.id,
        username: u.username,
        usernameDisplay: inputUsername,
        role: u.role,
        clinicId: u.clinicId || cid,
        displayName: u.displayName || null,
        permissions: u.permissions || {},
        active: u.active !== false,
        isDoctor: !!u.isDoctor,
        // B2 · profile.preferences.theme cross-device persistence (J.2.b shape v2).
        // Si user legacy sin profile, undefined · client aplica DEFAULT_PROFILE on-read.
        profile: u.profile || null,
      };
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

  // Tamaño del body (Vercel no nos da req.socket.bytesRead fácil, así que
  // chequeamos el string o el objeto serializado).
  let body = readBody(req);
  if (!body) {
    return res.status(400).json({ error: "Invalid body" });
  }
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return res.status(400).json({ error: "username y password requeridos" });
  }

  try {
    // Account lockout (PR-C · pedido owner): bloqueo por cuenta tras MAX_ATTEMPTS
    // fallos en la ventana. Complementa el rate-limit por IP. Soft-fail si Upstash
    // no está configurado (no bloquea logins legítimos).
    const lock = await checkLockout(username);
    if (lock.locked) {
      const mins = Math.ceil((lock.retryAfterSec || 0) / 60);
      return res.status(429).json({
        error: `Cuenta bloqueada por demasiados intentos. Probá de nuevo en ${mins} min.`,
        retryAfterSec: lock.retryAfterSec,
      });
    }

    const db = getAdminDb();
    let user =
      (await tryDynamicClinicAdmin(db, username, password)) ||
      (await tryNormalUser(db, username, password));

    if (!user) {
      // Credenciales inválidas → registramos el intento fallido (anti fuerza bruta).
      const attempts = await recordFailedAttempt(username);
      const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
      // No distingo si falló el username o el password (anti user-enumeration).
      return res.status(401).json({ error: "Credenciales inválidas", attemptsRemaining: remaining });
    }
    if (user.active === false) {
      return res.status(403).json({ error: "Usuario deshabilitado" });
    }

    // Login OK → limpiamos el contador de intentos fallidos de esa cuenta.
    await clearAttempts(username);
    const token = signSession(user);
    // Lo que devolvemos al cliente: user sin password + token.
    return res.status(200).json({ user, token });
  } catch (e) {
    // BACKEND-012: logSafeError — scrub body/err.cause antes de mandar a Vercel logs.
    logSafeError("auth/login", e);
    return res.status(500).json({ error: "Login failed" });
  }
}
