// CORS helper centralizado (BACKEND-001 / BACKEND-010 / BACKEND-011).
//
// Reemplaza los 7 `setCORS(res)` locales y el `Access-Control-Allow-Origin: *`
// global del vercel.json. Solo setea el header Origin si el request viene de
// un origin allowlisted (definido en `./auth.js`). Para orígenes no permitidos,
// no se setea el header → el browser bloquea la respuesta (defensa-en-profundidad
// junto al 403 explícito de `assertAllowedOrigin`).
//
// Uso en un handler:
//   import { setCORS, handleOptions } from "../_lib/cors.js";
//   export default async function handler(req, res) {
//     setCORS(req, res);
//     if (handleOptions(req, res)) return;
//     if (!assertAllowedOrigin(req, res)) return;
//     // ...
//   }

import { isOriginAllowed } from "./auth.js";

/**
 * Setea los headers CORS.
 *  - Allow-Origin: se setea SOLO si el origin es allowlisted (no `*`).
 *  - Vary: Origin, para que los caches no mezclen respuestas entre orígenes.
 *  - Methods/Headers/Content-Type: fijos.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ methods?: string }} [opts]
 */
export function setCORS(req, res, { methods = "POST, OPTIONS" } = {}) {
  const origin = (req.headers?.origin || "").trim().replace(/\/$/, "");
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");
}

/**
 * Maneja el preflight OPTIONS. Llamar después de `setCORS()`.
 *  - Si el origin NO es allowed: 403 + body explicativo.
 *  - Si es allowed (o ausente, dev): 204 No Content.
 *
 * @returns {boolean} true si el request era OPTIONS y ya se respondió.
 */
export function handleOptions(req, res) {
  if (req.method !== "OPTIONS") return false;
  const origin = (req.headers?.origin || "").trim().replace(/\/$/, "");
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({ error: "Forbidden" });
    return true;
  }
  res.status(204).end();
  return true;
}
