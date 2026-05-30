// POST /api/admin/clinics/upsert · Fase 2 PR-A
//
// Crea o actualiza una clínica + su clinic admin, vía Admin SDK.
//   - master: gestiona cualquier clínica (config + admin + branding · alta/baja).
//   - clinicAdmin: edita SOLO su propia clínica · institucional + branding (NO
//     modules/connections/status ni identidad del admin · ver CLINIC_FIELDS_*).
//   1. Verifica al caller (master o clinicAdmin de la clínica).
//   2. Resuelve/crea el Firebase Auth user del clinic admin (email) → clinicAdminUid.
//   3. Escribe `platformClinics/{id}` (merge · SIN clinicAdminPassword plaintext).
//   4. Crea/actualiza `clinics/{id}/users/{uid}` con role clinicAdmin (para que
//      hydrateUser lo encuentre y setClinicMemberClaims setee sus claims).
//   5. Invite best-effort al admin.
//
// El `setDoc(merge:true)` sobre platformClinics evita pisar branding/usage
// (fix del full-replace latente del savePlatformClinic legacy).
//
// body: {
//   clinic: { id, name, location?, modules?, connections?, status?, active? },
//   clinicAdmin?: { email, displayName?, username? },   // requerido si la clínica es nueva
//   password?: string                                    // opcional para el admin
// }
// 200: { ok: true, clinicId, clinicAdminUid?, created: boolean, invite }

import { assertAllowedOrigin } from "../../_lib/auth.js";
import { setCORS, handleOptions } from "../../_lib/cors.js";
import { getAdminDb } from "../../_lib/firebaseAdmin.js";
import { bearerFromReq, verifySession } from "../../_lib/jwt.js";
import { sendEmail } from "../../_lib/resendClient.js";
import { logSafeError } from "../../_lib/logSafe.js";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";

const MAX_BODY_BYTES = 64 * 1024; // clínicas pueden traer modules/connections + logo refs
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Campos que el MASTER puede setear (config comercial completa + admin + institucional + branding).
const CLINIC_FIELDS_MASTER = new Set([
  "id", "name", "location", "status", "active",
  "modules", "connections",
  "logoBase64", "logoDataUrl",
  "clinicAdminUid", "clinicAdminUsername", "clinicAdminDisplayName",
  // institucional + branding (compartidos con el clinicAdmin)
  "legalName", "taxId", "address", "phone", "contactEmail", "website",
  "primaryColor", "detectedPalette", "theme", "flags",
]);
// Campos que un clinicAdmin puede setear en SU clínica · SOLO institucional + branding.
// NO incluye modules/connections/status/active (config comercial · master-only) ni la
// identidad del admin (clinicAdminUid/Username/DisplayName · master-only).
const CLINIC_FIELDS_CLINICADMIN = new Set([
  "id", "name",
  "legalName", "taxId", "address", "phone", "contactEmail", "website",
  "logoBase64", "logoDataUrl", "primaryColor", "detectedPalette", "theme", "flags",
]);

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  return null;
}

function randomTempPassword() {
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

  const claims = verifySession(bearerFromReq(req));
  if (!claims || !claims.role) return res.status(401).json({ error: "No autenticado" });
  const callerRole = claims.role;
  const callerClinicId = claims.clinicId ?? null;

  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Body inválido" });
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const c = body.clinic && typeof body.clinic === "object" ? body.clinic : null;
  const clinicId = c && typeof c.id === "string" ? c.id.trim() : "";
  if (!clinicId) return res.status(400).json({ error: "clinic.id requerido" });

  // Authz: el master gestiona cualquier clínica · un clinicAdmin SOLO la suya
  // (datos institucionales + branding · ver CLINIC_FIELDS_CLINICADMIN).
  const isMasterCaller = callerRole === "masterAdmin";
  const isOwnClinicAdmin = callerRole === "clinicAdmin" && callerClinicId === clinicId;
  if (!isMasterCaller && !isOwnClinicAdmin) {
    return res.status(403).json({ error: "No autorizado para gestionar esta clínica" });
  }

  try {
    // getAdminDb() hace initializeApp() · DEBE ir antes de getAuth() o en cold
    // start getAuth() tira app/no-app → 500 (mismo bug latente que J.1.a en
    // firebase-login.js · commit e501ad3).
    const db = getAdminDb();
    const auth = getAuth();
    const clinicRef = db.doc(`platformClinics/${clinicId}`);
    const existing = (await clinicRef.get()).data() || {};
    const isNew = Object.keys(existing).length === 0;

    // Un clinicAdmin solo EDITA su clínica existente · nunca crea.
    if (isNew && !isMasterCaller) {
      return res.status(403).json({ error: "No autorizado para crear clínicas" });
    }

    // --- Clinic admin (Firebase Auth) · SOLO el master gestiona la identidad del admin ---
    let clinicAdminUid = existing.clinicAdminUid || null;
    let created = false;
    let invite = { delivered: false, reason: "skipped" };
    const admin = isMasterCaller && body.clinicAdmin && typeof body.clinicAdmin === "object" ? body.clinicAdmin : null;
    const email = admin && typeof admin.email === "string" ? admin.email.trim().toLowerCase() : "";

    if (isNew && !email) {
      return res.status(400).json({ error: "clinicAdmin.email requerido para una clínica nueva" });
    }
    if (email) {
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "clinicAdmin.email inválido" });
      const password = typeof body.password === "string" && body.password.length >= 8 ? body.password : null;
      let fbUser = null;

      // Si la clínica YA tiene admin (clinicAdminUid), esa cuenta es la identidad
      // canónica: un cambio de email RENOMBRA esa cuenta, nunca crea una segunda.
      // (Sin esto, editar una clínica y tipear un email distinto al actual creaba
      // un admin duplicado · los admins migrados tienen email temporal.)
      if (existing.clinicAdminUid) {
        try { fbUser = await auth.getUser(existing.clinicAdminUid); }
        catch (e) { if (e?.code !== "auth/user-not-found") throw e; } // uid stale → resolvemos por email abajo
      }

      if (fbUser) {
        const updates = {};
        if (fbUser.email !== email) updates.email = email;
        if (password) updates.password = password;
        if (Object.keys(updates).length) await auth.updateUser(fbUser.uid, updates);
      } else {
        // Clínica nueva (o uid stale): resolver por email · crear si no existe.
        try { fbUser = await auth.getUserByEmail(email); }
        catch (e) { if (e?.code !== "auth/user-not-found") throw e; }
        if (!fbUser) {
          fbUser = await auth.createUser({
            email,
            password: password || randomTempPassword(),
            displayName: admin.displayName || undefined,
            emailVerified: false,
          });
          created = true;
        } else if (password) {
          await auth.updateUser(fbUser.uid, { password });
        }
      }
      clinicAdminUid = fbUser.uid;

      // Doc del clinic admin como member (role clinicAdmin · habilita claims + hydrateUser).
      await db.doc(`clinics/${clinicId}/users/${clinicAdminUid}`).set({
        uid: clinicAdminUid,
        email,
        role: "clinicAdmin",
        clinicId,
        displayName: admin.displayName || existing.clinicAdminDisplayName || "Administrador",
        username: admin.username || undefined,
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
        ...(created ? { createdAt: FieldValue.serverTimestamp() } : {}),
      }, { merge: true });

      // Custom claims directo (self-contained · sin depender de los CFs) · habilita
      // acceso del clinic admin a su clínica bajo las rules TARGET.
      await auth.setCustomUserClaims(clinicAdminUid, { role: "clinicAdmin", clinicId });

      // Invite best-effort si es nuevo y no se fijó password.
      if (created && body.sendInvite !== false && !password) {
        try {
          invite = await sendEmail({
            to: email,
            subject: "Acceso de administrador · Ferti IA Suite",
            html: `<p>Se creó la clínica <strong>${c.name || clinicId}</strong> en Ferti IA Suite y sos su administrador/a.</p>
                   <p>Ingresá con <strong>${email}</strong> y usá "¿Olvidaste tu contraseña?" en el login para definir tu contraseña.</p>`,
          });
        } catch (e) {
          logSafeError("admin/clinics/upsert·invite", e);
          invite = { delivered: false, reason: "invite-error" };
        }
      }
    }

    // --- platformClinics doc · merge · whitelist POR ROL · SIN password plaintext ---
    const fields = isMasterCaller ? CLINIC_FIELDS_MASTER : CLINIC_FIELDS_CLINICADMIN;
    const patch = {};
    for (const [k, v] of Object.entries(c)) {
      if (fields.has(k) && v !== undefined) patch[k] = v;
    }
    patch.id = clinicId;
    // La identidad del admin solo la persiste el master (admin = null si clinicAdmin).
    if (isMasterCaller && clinicAdminUid) patch.clinicAdminUid = clinicAdminUid;
    if (admin?.displayName) patch.clinicAdminDisplayName = admin.displayName;
    if (admin?.username) patch.clinicAdminUsername = admin.username;
    patch.updatedAt = FieldValue.serverTimestamp();
    if (isNew) patch.createdAt = FieldValue.serverTimestamp();
    // Defensa: nunca persistir password plaintext aunque venga en el body.
    delete patch.clinicAdminPassword;
    await clinicRef.set(patch, { merge: true });

    return res.status(200).json({ ok: true, clinicId, clinicAdminUid, created, invite });
  } catch (e) {
    logSafeError("admin/clinics/upsert", e);
    if (e?.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Ese email de admin ya está en uso" });
    }
    return res.status(500).json({ error: "No se pudo guardar la clínica" });
  }
}
