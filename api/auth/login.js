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
// Este endpoint replica la escalera del antiguo authUser() pero en el servidor:
//   1. Master Admin (env var)
//   2. Clinic Admin CEGYR (env var)
//   3. Dynamic Clinic Admins (platformClinics.clinicAdminPassword)
//   4. Usuarios normales (clinics/{cid}/users con prefijo "clinicId_username")
//
// Los pasos 3 y 4 leen con firebase-admin (bypass de rules), así los passwords
// NO tienen que estar legibles desde el cliente. Las reglas de Firestore para
// cliente pueden cerrar users/ y platformClinics.*Password.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { hashPassword, verifyPassword } from "../_lib/password.js";
import { signSession } from "../_lib/jwt.js";

const MAX_BODY_BYTES = 10 * 1024; // 10 KB. Un login no necesita más.

function readBody(req) {
  // Vercel ya parsea JSON si el content-type lo dice, pero por si viene crudo:
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function buildMasterUser() {
  const username = process.env.FERTI_MASTER_USERNAME || "FertiAdmin";
  const passwordPlain = process.env.FERTI_MASTER_PASSWORD || "";
  const passwordHash = process.env.FERTI_MASTER_PASSWORD_HASH || "";
  return {
    id: "__master__",
    username,
    passwordPlain,
    passwordHash,
    role: "masterAdmin",
    displayName: "Master Admin",
    clinicId: null,
    permissions: { analysis: true, portal: true, stats: true, training: true, admin: true },
  };
}

function buildCegyrAdmin() {
  const username = process.env.FERTI_CEGYR_USERNAME || "Laboratoriocegyr";
  const passwordPlain = process.env.FERTI_CEGYR_PASSWORD || "";
  const passwordHash = process.env.FERTI_CEGYR_PASSWORD_HASH || "";
  return {
    id: "__clinicadmin_cegyr__",
    username,
    passwordPlain,
    passwordHash,
    role: "clinicAdmin",
    displayName: "Administrador CEGYR",
    clinicId: "cegyr",
    permissions: { analysis: true, portal: true, stats: true, training: true, admin: true },
  };
}

async function tryHardcodedAdmin(admin, inputUsername, inputPassword) {
  if (admin.username !== inputUsername) return null;
  // Preferimos hash; si no hay hash pero hay plaintext (fallback de bootstrap),
  // usamos plaintext. Nunca matcheamos contra string vacío.
  const stored = admin.passwordHash || admin.passwordPlain;
  if (!stored) return null;
  const { match } = await verifyPassword(inputPassword, stored);
  if (!match) return null;
  // Lo que devolvemos para JWT — sin password.
  const { passwordPlain: _p, passwordHash: _h, ...safe } = admin;
  return safe;
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
  const clinicsSnap = await db.collection("clinics").get();
  const lower = inputUsername.trim().toLowerCase();
  for (const cDoc of clinicsSnap.docs) {
    const cid = cDoc.id;
    const prefixed = `${cid}_${lower}`;
    const usersSnap = await db.collection(`clinics/${cid}/users`)
      .where("username", "==", prefixed)
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
    };
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
    const master = buildMasterUser();
    const cegyr = buildCegyrAdmin();

    let user =
      (await tryHardcodedAdmin(master, username, password)) ||
      (await tryHardcodedAdmin(cegyr, username, password));

    if (!user) {
      const db = getAdminDb();
      user =
        (await tryDynamicClinicAdmin(db, username, password)) ||
        (await tryNormalUser(db, username, password));
    }

    if (!user) {
      // No distingo si falló el username o el password (anti user-enumeration).
      return res.status(401).json({ error: "Credenciales inválidas" });
    }
    if (user.active === false) {
      return res.status(403).json({ error: "Usuario deshabilitado" });
    }

    const token = signSession(user);
    // Lo que devolvemos al cliente: user sin password + token.
    return res.status(200).json({ user, token });
  } catch (e) {
    console.error("[auth/login] failed:", e?.message || e);
    return res.status(500).json({ error: "Login failed" });
  }
}
