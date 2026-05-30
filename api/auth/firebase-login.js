// POST /api/auth/firebase-login
// body: { idToken }
// 200: { user, token }   // mismo shape que /api/auth/login (compat session.js)
// 401: { error: "Invalid ID token" }
//
// Fase J.1.a · Brief Fase J §J.1.a · decisión D1 arch decisions (90-day bcrypt
// + Firebase Auth coexistence).
//
// Cliente flow:
//   1. signInWithEmailAndPassword(auth, email, password) (Firebase Auth client SDK)
//   2. result.user.getIdToken() → idToken
//   3. POST /api/auth/firebase-login con { idToken }
//   4. Server verifica con firebase-admin auth.verifyIdToken
//   5. Hidrata user shape compatible con session.js · firma JWT propio · 12h TTL.
//
// Por qué sumar JWT propio en vez de usar el ID token directamente:
//   - session.js cliente espera el shape { user, token } que ya conoce.
//   - Custom JWT firmado por nuestro server permite revocación server-side
//     (blacklist en Firestore) · ID token de Firebase no se puede revocar pre-expiry.
//   - Migración aditiva · session.js cliente NO cambia.
//
// Feature flag: FIREBASE_AUTH_ENABLED env var (default false). Sin él, endpoint
// retorna 503 · cliente cae al login bcrypt legacy (decisión D1 coexistence).

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { signSession } from "../_lib/jwt.js";
import { logSafeError } from "../_lib/logSafe.js";
import { getAuth } from "firebase-admin/auth";

// J.2 scope: cliente consume migrateLegacyPermissions del shared. Server
// pasa permissions raw (lazy migration on read del cliente). Esto evita
// dep cross-workspace que Vercel deploy podría no resolver.

const MAX_BODY_BYTES = 8 * 1024;

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function isEnabled() {
  return process.env.FIREBASE_AUTH_ENABLED === "true";
}

/**
 * Hidrata user shape (compat session.js) desde Firebase Auth + Firestore.
 *
 * Master: lee `masterAdmins/{uid}` · role = "masterAdmin", clinicId = null.
 * ClinicAdmin/User: lee `clinics/{cid}/users/{uid}` · clinicId from custom claim.
 */
async function hydrateUser(db, fbUser, decoded) {
  const role = decoded.role || decoded.claims?.role;
  const clinicId = decoded.clinicId || decoded.claims?.clinicId;

  if (role === "masterAdmin") {
    const snap = await db.doc(`masterAdmins/${fbUser.uid}`).get();
    const data = snap.exists ? snap.data() : {};
    return {
      id: fbUser.uid,
      uid: fbUser.uid,
      email: fbUser.email,
      username: data.email || fbUser.email,
      displayName: data.displayName || "Master Admin",
      role: "masterAdmin",
      clinicId: null,
      permissions: data.permissions || {},
    };
  }

  if (!clinicId) {
    throw new Error("clinicId claim missing for non-master user");
  }

  const userSnap = await db.doc(`clinics/${clinicId}/users/${fbUser.uid}`).get();
  if (!userSnap.exists) {
    throw new Error(`user doc missing: clinics/${clinicId}/users/${fbUser.uid}`);
  }
  const u = userSnap.data();
  return {
    id: fbUser.uid,
    uid: fbUser.uid,
    email: fbUser.email,
    username: u.username || fbUser.email,
    displayName: u.displayName || u.profile?.firstName || fbUser.email,
    role: role || u.role || "user",
    clinicId,
    permissions: u.permissions || {},
    active: u.active !== false,
    isDoctor: !!u.isDoctor,
  };
}

export default async function handler(req, res) {
  setCORS(req, res, { methods: "POST, OPTIONS" });
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertAllowedOrigin(req, res)) return;

  if (!isEnabled()) {
    return res.status(503).json({
      error: "feature-disabled",
      detail: "Firebase Auth migration not enabled · usá /api/auth/login (bcrypt legacy)",
    });
  }

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Invalid body" });
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const idToken = typeof body.idToken === "string" ? body.idToken : "";
  if (!idToken) return res.status(400).json({ error: "idToken requerido" });

  try {
    // Inicializa el Firebase Admin default app ANTES de usar getAuth(): en cold
    // start, sin app inicializada, getAuth().verifyIdToken() tira y cae al catch
    // genérico ("Invalid ID token"). getAdminDb() corre initializeApp(). (Bug
    // latente J.1.a · surfaceado al activar FIREBASE_AUTH_ENABLED por 1ª vez.)
    const db = getAdminDb();
    const decoded = await getAuth().verifyIdToken(idToken, true /* checkRevoked */);
    const fbUser = await getAuth().getUser(decoded.uid);
    if (fbUser.disabled) {
      return res.status(403).json({ error: "Usuario deshabilitado" });
    }

    const user = await hydrateUser(db, fbUser, decoded);

    if (user.active === false) {
      return res.status(403).json({ error: "Usuario deshabilitado" });
    }

    const token = signSession(user);
    return res.status(200).json({ user, token });
  } catch (e) {
    logSafeError("auth/firebase-login", e);
    return res.status(401).json({ error: "Invalid ID token" });
  }
}
