// Helpers de password con estrategia dual-read (SEC-005 / SEC-007 audit P0).
//
// Hoy los passwords están en plaintext en Firestore. Migrar de un saque a
// bcrypt sería un big-bang con downtime (todos los usuarios existentes se
// quedarían afuera hasta que alguien resetee su password manualmente).
//
// Estrategia: cada login verifica así:
//   1. Si el password almacenado parece un hash bcrypt ($2a$ / $2b$ / $2y$),
//      usamos bcrypt.compare.
//   2. Si no parece hash, comparamos plaintext. Si matchea, AUTO-MIGRAMOS:
//      re-hasheamos y actualizamos el doc en Firestore con passwordUpdatedAt.
//
// Así, cada login de usuario existente es también una migración silenciosa.
// Después de N días (métrica: % de users con password_bcrypt), el código
// plaintext se puede remover.

import bcrypt from "bcryptjs";

const ROUNDS = 12; // cost factor bcrypt. 12 ≈ 250ms por hash en serverless.
const BCRYPT_PREFIX_RE = /^\$2[aby]\$/;

export function isBcryptHash(s) {
  return typeof s === "string" && BCRYPT_PREFIX_RE.test(s) && s.length >= 59;
}

export async function hashPassword(plain) {
  if (!plain || typeof plain !== "string") throw new Error("password vacío");
  return bcrypt.hash(plain, ROUNDS);
}

// Devuelve { match: boolean, needsRehash: boolean }.
// needsRehash=true cuando el stored era plaintext y el match fue positivo
// — ese es el trigger para la auto-migración.
export async function verifyPassword(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string" || !stored.length) {
    return { match: false, needsRehash: false };
  }
  if (isBcryptHash(stored)) {
    const ok = await bcrypt.compare(plain, stored);
    return { match: ok, needsRehash: false };
  }
  // Plaintext comparison — migración pendiente para este usuario.
  const ok = stored === plain;
  return { match: ok, needsRehash: ok };
}
