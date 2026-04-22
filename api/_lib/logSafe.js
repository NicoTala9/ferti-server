// Helper para loguear errores en Vercel logs sin filtrar PII.
//
// BACKEND-012 (audit P1, 2026-04-22):
//   Los handlers hacían `console.error("xxx error:", err)` pasando el objeto
//   de error completo. En prod eso puede incluir:
//     - Stack traces con fragmentos del request body (base64 de imágenes
//       de pacientes, emails, datos clínicos).
//     - Errores del SDK de Anthropic que reproducen el request original.
//     - Cualquier `err.cause` anidado que referencie el payload entrante.
//
//   Vercel logs no son append-only ni cifrados — quedan accesibles a
//   cualquiera con acceso al proyecto. Esta función extrae SOLO lo que
//   necesitamos para debuggear (tipo, mensaje, stack top, código) y descarta
//   el resto.
//
// Uso:
//   import { logSafeError } from "../_lib/logSafe.js";
//   try { ... } catch (err) {
//     logSafeError("oocyte", err);
//     return res.status(500).json({ error: "Analysis failed" });
//   }

const MAX_MESSAGE = 500;    // chars
const MAX_STACK_LINES = 8;

/**
 * Loguea un error con metadatos útiles y sin PII.
 * Siempre usa `console.error` — la separación stderr/stdout se preserva en Vercel.
 *
 * @param {string} tag — prefijo identificador del endpoint (ej "oocyte", "auth/login").
 * @param {unknown} err — el error atrapado.
 */
export function logSafeError(tag, err) {
  const meta = safeErrorMeta(err);
  console.error(`[${tag}]`, JSON.stringify(meta));
}

/**
 * Version sin side-effects — útil para testing o para componer logs custom.
 * @param {unknown} err
 */
export function safeErrorMeta(err) {
  if (!err) return { name: "nullish", message: String(err) };
  if (typeof err !== "object") {
    return { name: typeof err, message: truncate(String(err), MAX_MESSAGE) };
  }
  const name = err.name || err.constructor?.name || "Error";
  const message = truncate(String(err.message || ""), MAX_MESSAGE);
  const stack = topStackLines(err.stack);
  const meta = { name, message };
  if (stack) meta.stack = stack;
  if (err.code != null) meta.code = String(err.code);
  if (err.status != null) meta.status = Number(err.status) || String(err.status);
  if (err.statusCode != null) meta.statusCode = Number(err.statusCode) || String(err.statusCode);
  // `err.cause` puede ser otro Error con su propio request body embedded —
  // lo reducimos recursivamente en vez de descartarlo entero.
  if (err.cause && err.cause !== err) {
    meta.cause = safeErrorMeta(err.cause);
  }
  return meta;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…(truncated)" : s;
}

function topStackLines(stack) {
  if (!stack || typeof stack !== "string") return "";
  const lines = stack.split("\n").slice(0, MAX_STACK_LINES + 1); // +1 for the "Error: ..." header
  return lines.join("\n");
}
