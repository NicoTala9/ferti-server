// Validación compartida entre endpoints (BACKEND-002 / BACKEND-004 / BACKEND-019 / BACKEND-025).

/**
 * Tamaño máximo de un string base64 que aceptamos como imagen/PDF.
 * 5 MB de base64 ≈ 3.75 MB binarios. Suficiente para una foto de celular o
 * un PDF de resultados de laboratorio normal, y frena DoS por payload gigante.
 */
export const MAX_BASE64_BYTES = 5 * 1024 * 1024;

/**
 * Valida que un string base64 exista y no exceda MAX_BASE64_BYTES.
 * Si no pasa, manda 400/413 y retorna false.
 *
 * @param {string|undefined} base64
 * @param {import("http").ServerResponse} res
 * @param {{ fieldName?: string, required?: boolean }} [opts]
 * @returns {boolean} true si el payload es válido.
 */
export function validateBase64(base64, res, { fieldName = "base64", required = true } = {}) {
  if (!base64) {
    if (required) {
      res.status(400).json({ error: `Missing ${fieldName}` });
      return false;
    }
    return true;
  }
  if (typeof base64 !== "string") {
    res.status(400).json({ error: `Invalid ${fieldName}` });
    return false;
  }
  if (base64.length > MAX_BASE64_BYTES) {
    res.status(413).json({ error: "Payload too large", maxBytes: MAX_BASE64_BYTES });
    return false;
  }
  return true;
}

/**
 * Whitelist de mime types aceptados para análisis con visión.
 */
export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
export const ALLOWED_DOC_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/**
 * Valida que el mimeType esté en la whitelist dada.
 * Si no pasa, manda 400 y retorna false.
 *
 * @param {string|undefined} mimeType
 * @param {string[]} allowed
 * @param {import("http").ServerResponse} res
 * @returns {boolean}
 */
export function validateMimeType(mimeType, allowed, res) {
  if (!mimeType) {
    // Se asume default en el handler (ej. "image/jpeg"); skipeamos.
    return true;
  }
  if (!allowed.includes(mimeType)) {
    res.status(400).json({ error: "Unsupported mime type" });
    return false;
  }
  return true;
}

/**
 * Valida edad de paciente. Acepta números enteros razonables.
 * Retorna el valor validado o el default, nunca NaN.
 *
 * @param {unknown} age
 * @param {number} [defaultValue=35]
 * @returns {number}
 */
export function sanitizeAge(age, defaultValue = 35) {
  const n = Number(age);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(60, Math.max(15, Math.round(n)));
}

/**
 * HTML escape · interpolation segura en email templates u otras strings que
 * acaben en HTML. NO usar para JSON · usar JSON.stringify para eso.
 * J.1.b · email templates recovery-{master,clinicAdmin}.
 */
export function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Valida un email string · pattern básico RFC compatible. NO valida deliverability.
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  // RFC 5322-lite: local@domain · domain con al menos un dot.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
