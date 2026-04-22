// Helpers para firmar/verificar JWTs. Se comparten entre login y verify.
//
// SEC-005 / SEC-007 (audit P0, 2026-04-20): movemos auth al backend porque
// hoy los passwords están en plaintext en Firestore y las reglas del cliente
// los dejan leer. El JWT que emite este server pasa a ser la única prueba de
// autenticación y se firma con JWT_SECRET (sólo conocida por este server).

import jwt from "jsonwebtoken";

// TTL por default: 12 horas. Suficiente para una jornada de trabajo sin
// molestar al usuario y corto para limitar ventana de abuso si se roba un
// token. Si el usuario cierra el browser, el token sigue válido hasta exp.
const DEFAULT_TTL = "12h";

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET env var missing or too short (mínimo 32 chars). Generá uno con `openssl rand -base64 48`."
    );
  }
  return secret;
}

// Firma un payload. Convenciones:
//   sub: userId  (ej "__master__", "__clinicadmin_cegyr__", "firestore-doc-id")
//   role: "masterAdmin" | "clinicAdmin" | "user"
//   clinicId: string | null
//   displayName, username, permissions
// No metemos `password` ni datos sensibles en el payload.
export function signSession(user, ttl = DEFAULT_TTL) {
  const payload = {
    sub: user.id,
    role: user.role,
    clinicId: user.clinicId ?? null,
    username: user.usernameDisplay || user.username,
    displayName: user.displayName || null,
    permissions: user.permissions || {},
  };
  return jwt.sign(payload, getSecret(), { expiresIn: ttl });
}

// Verifica y devuelve el payload, o null si el token es inválido/expirado.
export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  try {
    return jwt.verify(token, getSecret());
  } catch {
    return null;
  }
}

// Extrae "Bearer <token>" de un header Authorization.
export function bearerFromReq(req) {
  const h = req.headers?.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}
