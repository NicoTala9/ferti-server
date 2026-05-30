// GET /api/auth/verify-firebase
// header: Authorization: Bearer <firebase-id-token>
// 200: { uid, role, clinicId, email }
// 401: { error: "Invalid or expired ID token" }
//
// Fase J.1.a · alternative a /api/auth/verify (que valida custom JWT).
// Cliente usa este endpoint cuando tiene Firebase Auth ID token directo
// (sin pasar por /api/auth/firebase-login para JWT custom).
//
// Útil para Cloud Function callable que verifican identidad sin re-loguear.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { logSafeError } from "../_lib/logSafe.js";
import { getAuth } from "firebase-admin/auth";

function isEnabled() {
  return process.env.FIREBASE_AUTH_ENABLED === "true";
}

function extractBearer(req) {
  const h = req.headers?.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice(7).trim();
}

export default async function handler(req, res) {
  setCORS(req, res, { methods: "GET, OPTIONS" });
  if (handleOptions(req, res)) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertAllowedOrigin(req, res)) return;
  if (!isEnabled()) {
    return res.status(503).json({ error: "feature-disabled" });
  }

  const idToken = extractBearer(req);
  if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer" });

  try {
    // initializeApp() ANTES de getAuth() · en cold start getAuth() sin app tira
    // app/no-app (mismo bug latente que J.1.a en firebase-login + clinics/users
    // upsert · commit bd4a572). Este endpoint no lo usa el flujo actual; fix
    // preventivo.
    getAdminDb();
    const decoded = await getAuth().verifyIdToken(idToken, true);
    return res.status(200).json({
      uid: decoded.uid,
      email: decoded.email,
      role: decoded.role || null,
      clinicId: decoded.clinicId || null,
    });
  } catch (e) {
    logSafeError("auth/verify-firebase", e);
    return res.status(401).json({ error: "Invalid or expired ID token" });
  }
}
