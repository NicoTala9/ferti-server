// Firebase Admin SDK singleton para uso server-side.
//
// OVOQ-018 (audit P0, 2026-04-20): Soft-delete nunca se purga. Los docs en
// `clinics/{cid}/deleted` (y `clinics/{cid}/analyses` con deletedAt en blasto-app)
// se acumulan indefinidamente. Necesitamos un cron que borre los > 30 días.
//
// Config: variable de entorno FIREBASE_SERVICE_ACCOUNT = JSON completo del
// service account. En Vercel se pega como una sola línea (JSON.stringify).
// Localmente se puede pegar el JSON tal cual.
//
// Export singleton para evitar re-init en warm lambdas.

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let _db = null;

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT env var missing. Pasá el JSON del service account (una línea stringificada)."
    );
  }
  // Puede venir como JSON pegado o como base64 (por si el Vercel dashboard
  // escapa mal los newlines del private_key).
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      json = JSON.parse(decoded);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT no es JSON válido ni base64 de JSON.");
    }
  }
  // Los private_key suelen venir con \n literales escapados en env vars.
  if (json.private_key && typeof json.private_key === "string") {
    json.private_key = json.private_key.replace(/\\n/g, "\n");
  }
  return json;
}

export function getAdminDb() {
  if (_db) return _db;
  if (!getApps().length) {
    const sa = parseServiceAccount();
    initializeApp({
      credential: cert(sa),
      projectId: sa.project_id || "oocyte-cegyr",
    });
  }
  _db = getFirestore();
  return _db;
}

// Normalizador de deletedAt. El campo aparece en formatos mixtos porque cada
// app lo escribió distinto históricamente:
//   - Firestore Timestamp (`{_seconds, _nanoseconds}` o instancia Timestamp)
//   - Number (ms desde epoch — oocyte/shared usan Date.now())
//   - String ISO (clinical + blasto)
// Devuelve ms since epoch o null si no se puede parsear.
export function deletedAtToMillis(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  // Firestore Timestamp tiene toMillis(), y el objeto plano expone _seconds.
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  if (typeof value._seconds === "number") {
    return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  }
  return null;
}
