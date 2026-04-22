// OVOQ-018: Endpoint del cron que purga soft-deleted > 30 días.
//
// Lo llama Vercel Cron (configurado en vercel.json) una vez por día.
// Vercel envía header `Authorization: Bearer <CRON_SECRET>`. También aceptamos
// ADMIN_TOKEN como fallback para invocación manual desde scripts/curl.
//
// NO usa assertAllowedOrigin porque el cron no tiene Origin (llega desde
// la infra de Vercel, no desde un browser).

import { runPurge } from "../_lib/purgeDeleted.js";

function isAuthorized(req) {
  const auth = req.headers?.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const cronSecret = process.env.CRON_SECRET;
  const adminToken = process.env.ADMIN_TOKEN;

  if (cronSecret && bearer === cronSecret) return true;
  if (adminToken && bearer === adminToken) return true;

  // Vercel Cron también puede venir con un header x-vercel-signature. Si tenés
  // CRON_SECRET configurado en Vercel, ya viene como Bearer de arriba — no
  // agregamos paths alternativos para evitar bypass por si alguien olvida setear
  // la env var.
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    console.warn("[purge-deleted] unauthorized call", { url: req.url });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const dryRun = req.query?.dryRun === "1" || req.query?.dry_run === "1";

  try {
    const summary = await runPurge({ dryRun });
    console.log("[purge-deleted] done", JSON.stringify(summary));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error("[purge-deleted] failed:", e);
    return res.status(500).json({ error: "Purge failed", detail: String(e?.message || e) });
  }
}
