// Rate limiting con Upstash Redis (BACKEND-003).
//
// Diseño:
//   - Usa `@upstash/ratelimit` con un sliding window de 30 req/min por IP.
//   - Las credenciales Upstash vienen de env vars:
//       UPSTASH_REDIS_REST_URL
//       UPSTASH_REDIS_REST_TOKEN
//   - Si las env vars NO están seteadas, `assertWithinRateLimit()` se vuelve
//     un no-op y emite un `console.warn` una sola vez. Esto permite deployar
//     el código sin romper prod mientras el usuario configura Upstash.
//   - Al setear las vars en Vercel (sin redeploy necesario tras el primer
//     deploy, solo reiniciar la función), el rate limit empieza a funcionar.
//
// Setup cuando estés listo:
//   1. Crear cuenta en https://upstash.com (tier free soporta >100k req/día).
//   2. Crear una DB Redis global.
//   3. En Vercel dashboard → Project Settings → Environment Variables:
//        UPSTASH_REDIS_REST_URL      = https://xxx.upstash.io
//        UPSTASH_REDIS_REST_TOKEN    = AxxAxx...
//   4. Redeploy o reiniciar funciones.
//
// Límite: 30 req/min/IP es suficiente para uso clínico normal (un embriólogo
// no sube más de 10-15 imágenes/min). Un atacante con curl queda bloqueado.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let ratelimitInstance = null;
let warnedAboutMissingConfig = false;

/**
 * Lazy-init del cliente Upstash.
 * Retorna null si las env vars no están seteadas (modo "permissive fallback").
 */
function getRateLimiter() {
  if (ratelimitInstance) return ratelimitInstance;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (!warnedAboutMissingConfig) {
      console.warn(
        "[rateLimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN no configuradas. " +
        "Rate limit DESACTIVADO — el backend acepta requests ilimitadas. " +
        "Ver packages/server/api/_lib/rateLimit.js para setup."
      );
      warnedAboutMissingConfig = true;
    }
    return null;
  }

  const redis = new Redis({ url, token });
  ratelimitInstance = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    analytics: false, // off para free tier; activar en paid si se quiere dashboard
    prefix: "ferti-rl",
  });
  return ratelimitInstance;
}

/**
 * Extrae la IP del cliente desde los headers de Vercel.
 * Fallback: "unknown" (todas las requests sin IP comparten el bucket).
 */
function getClientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.headers?.["x-real-ip"] || "unknown";
}

/**
 * Llamá esto al inicio de cada handler (después de assertAllowedOrigin).
 * Si retorna false, el handler ya envió 429 y debe abortar.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @returns {Promise<boolean>} true si la request está dentro del límite.
 */
export async function assertWithinRateLimit(req, res) {
  const limiter = getRateLimiter();
  if (!limiter) return true; // soft-fail: no-op si Upstash no configurado

  const ip = getClientIp(req);
  try {
    const { success, limit, remaining, reset } = await limiter.limit(ip);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
    res.setHeader("X-RateLimit-Reset", String(reset));

    if (!success) {
      console.warn("[rateLimit] 429 for ip:", ip, "path:", req.url);
      res.status(429).json({ error: "Too many requests" });
      return false;
    }
    return true;
  } catch (err) {
    // Si Upstash está caído, NO bloqueamos requests legítimas. Logueamos y seguimos.
    console.error("[rateLimit] Upstash error (fail-open):", err?.message);
    return true;
  }
}
