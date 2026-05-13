// Recovery tokens helpers · Fase J.1.b
//
// Token de 6 dígitos · TTL 15min · 3 requests/hora/email rate limit
// (decisión D6 arch decisions J.1 · feedback inmediato UX-friendlier).
//
// Storage: colección `passwordRecoveryTokens/{tokenId}` en Firestore.
// firestore.rules.target deny-all clientes · solo Admin SDK escribe/lee.
//
// Token shape:
//   {
//     tokenId: string,                  // hash del token + email (no el token claro)
//     emailHash: string,                // hash del email (anti enumeración)
//     codeHash: string,                  // hash del 6-digit code (constant-time compare)
//     userType: "master" | "clinicAdmin",
//     uid: string,                       // Firebase Auth uid · null si user no migrado bcrypt-legacy
//     expiresAt: number,                 // epoch ms
//     createdAt: number,
//     used: boolean,
//   }

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3;

/**
 * Genera un código de 6 dígitos cripto-seguro (no Math.random).
 * Range: 000000 - 999999 (con leading zeros).
 */
export function generateRecoveryCode() {
  const n = randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

/**
 * Hash determinístico de email + code para storage.
 * Usamos SHA-256 (no bcrypt) porque:
 *   - El token tiene TTL 15min · no necesita key-stretching.
 *   - Lookup debe ser O(1) por (email, code) hash.
 */
export function hashRecoveryCode(code, salt = "ferti-recovery-v1") {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

export function hashEmail(email) {
  const norm = (email || "").trim().toLowerCase();
  return createHash("sha256").update(`ferti-email:${norm}`).digest("hex");
}

/**
 * Constant-time compare hex strings (anti-timing attacks).
 */
export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Crea un doc en `passwordRecoveryTokens` con el code hash.
 * Retorna el code claro (para enviar via email · NO se persiste).
 *
 * @param {object} db Firestore Admin DB instance
 * @param {object} args
 * @param {string} args.email
 * @param {"master"|"clinicAdmin"} args.userType
 * @param {string|null} args.uid Firebase Auth uid si migrado · null si bcrypt-legacy
 * @returns {Promise<{ code: string, tokenId: string }>}
 */
export async function createRecoveryToken(db, { email, userType, uid = null }) {
  const code = generateRecoveryCode();
  const codeHash = hashRecoveryCode(code);
  const emailHash = hashEmail(email);
  const tokenId = createHash("sha256").update(`${emailHash}:${Date.now()}`).digest("hex").slice(0, 32);
  const now = Date.now();
  await db.doc(`passwordRecoveryTokens/${tokenId}`).set({
    tokenId,
    emailHash,
    codeHash,
    userType,
    uid,
    expiresAt: now + TOKEN_TTL_MS,
    createdAt: now,
    used: false,
  });
  return { code, tokenId };
}

/**
 * Valida un (email, code) contra Firestore. NO marca como used; el caller debe
 * hacer eso en una transacción separada para evitar replay.
 *
 * @returns {Promise<{ valid: boolean, doc?: object, reason?: string }>}
 */
export async function validateRecoveryToken(db, { email, code }) {
  const emailHash = hashEmail(email);
  const codeHash = hashRecoveryCode(code);
  // Lookup por (emailHash, codeHash) · usa where().limit(1) para evitar full scan.
  const snap = await db
    .collection("passwordRecoveryTokens")
    .where("emailHash", "==", emailHash)
    .where("codeHash", "==", codeHash)
    .where("used", "==", false)
    .limit(1)
    .get();
  if (snap.empty) return { valid: false, reason: "not-found" };
  const doc = snap.docs[0];
  const data = doc.data();
  if (data.expiresAt < Date.now()) {
    return { valid: false, reason: "expired" };
  }
  if (!safeEqualHex(data.codeHash, codeHash)) {
    // shouldn't happen given the where filter, but defensive.
    return { valid: false, reason: "code-mismatch" };
  }
  return { valid: true, doc: { id: doc.id, ref: doc.ref, ...data } };
}

/**
 * Rate limit por email · 3 requests / hora.
 * Storage: doc `rateLimits/recovery/{emailHash}` en Firestore.
 *
 * @returns {Promise<{ allowed: boolean, remaining: number, resetAt: number }>}
 */
export async function checkRecoveryRateLimit(db, email) {
  const emailHash = hashEmail(email);
  const ref = db.doc(`rateLimits/recovery_${emailHash}`);
  const now = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const windowStart = data?.windowStart ?? now;
    const expired = now - windowStart > RATE_LIMIT_WINDOW_MS;
    const newCount = expired ? 1 : (data?.count ?? 0) + 1;
    const newWindowStart = expired ? now : windowStart;
    if (newCount > RATE_LIMIT_MAX) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: newWindowStart + RATE_LIMIT_WINDOW_MS,
      };
    }
    tx.set(ref, {
      windowStart: newWindowStart,
      count: newCount,
      updatedAt: now,
    });
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX - newCount,
      resetAt: newWindowStart + RATE_LIMIT_WINDOW_MS,
    };
  });
  return result;
}
