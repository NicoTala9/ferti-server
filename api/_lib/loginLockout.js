// Account lockout · Fase 2 PR-C (pedido owner 2026-05-24).
//
// Bloquea una CUENTA (por username/email) tras N intentos fallidos de login,
// durante una ventana de tiempo (auto-desbloqueo). Complementa rateLimit.js
// (que es por IP) — esto es por identidad, para frenar fuerza bruta dirigida.
//
// Storage: Upstash Redis (mismo que rateLimit.js · UPSTASH_REDIS_REST_URL/TOKEN).
// Soft-fail: si Upstash no está configurado, es no-op (no bloquea logins) y avisa
// una vez — permite deployar sin romper hasta que el owner configure Upstash.
//
// Política (owner-ratificada): 3 intentos → bloqueo 15 min (auto-desbloqueo por TTL).
// Un login exitoso limpia el contador. El Master puede resetear con clearAttempts().

import { Redis } from "@upstash/redis";

export const MAX_ATTEMPTS = 3;
export const LOCK_WINDOW_SEC = 15 * 60; // 15 minutos
const PREFIX = "ferti-lockout:";

let redis = null;
let warned = false;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!warned) {
      console.warn("[loginLockout] Upstash no configurado · account lockout DESACTIVADO.");
      warned = true;
    }
    return null;
  }
  redis = new Redis({ url, token });
  return redis;
}

const keyFor = (id) => `${PREFIX}${String(id || "").trim().toLowerCase()}`;

/** ¿La cuenta está bloqueada? → { locked, retryAfterSec?, attempts } */
export async function checkLockout(identifier) {
  const r = getRedis();
  if (!r || !identifier) return { locked: false, attempts: 0 };
  try {
    const key = keyFor(identifier);
    const count = Number(await r.get(key)) || 0;
    if (count >= MAX_ATTEMPTS) {
      const ttl = await r.ttl(key);
      return { locked: true, retryAfterSec: ttl > 0 ? ttl : LOCK_WINDOW_SEC, attempts: count };
    }
    return { locked: false, attempts: count };
  } catch (e) {
    console.error("[loginLockout] check error (fail-open):", e?.message);
    return { locked: false, attempts: 0 };
  }
}

/** Registra un intento fallido. Devuelve el total de intentos en la ventana. */
export async function recordFailedAttempt(identifier) {
  const r = getRedis();
  if (!r || !identifier) return 0;
  try {
    const key = keyFor(identifier);
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, LOCK_WINDOW_SEC); // arranca la ventana en el 1er fallo
    return count;
  } catch (e) {
    console.error("[loginLockout] record error (fail-open):", e?.message);
    return 0;
  }
}

/** Limpia el contador (login exitoso · o reset manual por admin/master). */
export async function clearAttempts(identifier) {
  const r = getRedis();
  if (!r || !identifier) return;
  try { await r.del(keyFor(identifier)); }
  catch (e) { console.error("[loginLockout] clear error:", e?.message); }
}
