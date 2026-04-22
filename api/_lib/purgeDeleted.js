// Purga soft-deleted > 30 días.
//
// OVOQ-018 (audit P0, 2026-04-20). Dos shapes distintas en producción:
//
//   A) Subcolección `clinics/{cid}/deleted/{docId}` — usan oocyte-app, sperm-app
//      y clinical-app. Mueven el doc original a /deleted con `deletedAt`
//      (Date.now ms, ISO string o Firestore Timestamp según la app).
//
//   B) Flag in-place `clinics/{cid}/analyses/{docId}` con `deletedAt != null`
//      — usa blasto-app. El doc sigue en analyses pero marcado.
//
// Iteramos ambas y borramos físicamente lo que lleve > retentionDays. Idempotente.
//
// Vive en api/_lib/ para que el sync script (packages/server → NicoTala9/ferti-server)
// lo copie y el handler de Vercel lo pueda importar. El CLI scripts/purge-deleted.mjs
// es sólo un wrapper para correr esto desde terminal.

import { getAdminDb, deletedAtToMillis } from "./firebaseAdmin.js";

const DEFAULT_RETENTION_DAYS = 30;

export async function runPurge({ dryRun = false, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`retentionDays inválido: ${retentionDays}`);
  }
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const db = getAdminDb();
  const summary = {
    dryRun,
    cutoffIso: new Date(cutoffMs).toISOString(),
    retentionDays,
    clinicsScanned: 0,
    deletedSubcolDocs: { scanned: 0, expired: 0, purged: 0, skippedNoDate: 0 },
    analysesFlagged: { scanned: 0, expired: 0, purged: 0, skippedNoDate: 0 },
    errors: [],
  };

  const clinicsSnap = await db.collection("clinics").get();
  summary.clinicsScanned = clinicsSnap.size;

  for (const clinicDoc of clinicsSnap.docs) {
    const cid = clinicDoc.id;

    // --- A) Subcolección /deleted (oocyte, sperm, clinical) ---
    try {
      const delSnap = await db.collection(`clinics/${cid}/deleted`).get();
      for (const doc of delSnap.docs) {
        summary.deletedSubcolDocs.scanned++;
        const data = doc.data();
        const ms = deletedAtToMillis(data?.deletedAt);
        if (ms == null) {
          summary.deletedSubcolDocs.skippedNoDate++;
          continue;
        }
        if (ms > cutoffMs) continue; // dentro del período, aún no purga
        summary.deletedSubcolDocs.expired++;
        if (!dryRun) {
          await doc.ref.delete();
          summary.deletedSubcolDocs.purged++;
        }
      }
    } catch (e) {
      summary.errors.push(`[${cid}] /deleted: ${e?.message || e}`);
    }

    // --- B) analyses con flag deletedAt (blasto) ---
    try {
      // No usamos .where('deletedAt','!=',null) porque Firestore trata los
      // campos ausentes como "no existe" y los tipos mixtos (ms/ISO/Timestamp)
      // hacen rara la query. Iteramos todos los docs y filtramos en memoria.
      const anSnap = await db.collection(`clinics/${cid}/analyses`).get();
      for (const doc of anSnap.docs) {
        const data = doc.data();
        if (data?.deletedAt == null) continue; // activos, saltar
        summary.analysesFlagged.scanned++;
        const ms = deletedAtToMillis(data.deletedAt);
        if (ms == null) {
          summary.analysesFlagged.skippedNoDate++;
          continue;
        }
        if (ms > cutoffMs) continue;
        summary.analysesFlagged.expired++;
        if (!dryRun) {
          await doc.ref.delete();
          summary.analysesFlagged.purged++;
        }
      }
    } catch (e) {
      summary.errors.push(`[${cid}] /analyses: ${e?.message || e}`);
    }
  }

  return summary;
}
