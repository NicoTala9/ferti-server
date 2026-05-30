// Vercel cron · keep-alive del CNN inference service en Cloud Run.
// ─────────────────────────────────────────────────────────────────────────────
// Cloud Run con min-instances=0 (scale-to-zero) duerme la instancia después
// de ~15 min sin tráfico. Cuando el primer embriólogo del día corre un análisis,
// espera 30-35s de cold start (12 modelos Keras load + TF init). UX malo.
//
// Solución cheap · cron Vercel cada 14 min pinguea /health del CNN service ·
// instancia siempre warm · primer request real responde en ~2s.
//
// Costo: $0 · Vercel free tier permite ≥2 crons (estamos con 1+1).
// Cloud Run · cada /health es <100ms · ~104 pings/día <<<< 2M req/mes free tier.
//
// Si en el futuro flipamos a min-instances=1 (always-on $25-30/mo) · este cron
// se vuelve redundante · borrar entry en vercel.json + este archivo.
//
// Auth · CRON_SECRET match con env var (Vercel auto-añade `Authorization:
// Bearer <token>` en requests de cron · validamos como purge-deleted.js).

import { setCORS, handleOptions } from "../_lib/cors.js";
import { timingSafeEqual } from "crypto";

const CNN_TIMEOUT_MS = 5000;

export default async function handler(req, res) {
  setCORS(req, res);
  if (handleOptions(req, res)) return;

  // Validación auth · solo el cron de Vercel puede triggerar esto
  const expectedAuth = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET not configured" });
  }
  // Audit P2 fix · constant-time comparison (timing attack teórico negligible
  // para tokens 32+ chars pero best-practice).
  const got = req.headers.authorization || "";
  const a = Buffer.from(got);
  const b = Buffer.from(expectedAuth);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const url = process.env.CNN_INFERENCE_URL;
  if (!url) {
    return res.status(500).json({ error: "CNN_INFERENCE_URL not configured" });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CNN_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const resp = await fetch(`${url}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const body = await resp.json().catch(() => ({}));

    return res.status(200).json({
      ok: resp.ok,
      status: resp.status,
      cnnStatus: body.status || null,
      elapsedMs,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    // No fallar el cron si el CNN está temporalmente down · cron sigue corriendo
    // cada 14 min · si recupera, próximo ping va a triggerar warm-up.
    return res.status(200).json({
      ok: false,
      error: e?.name === "AbortError" ? "timeout" : (e?.message || String(e)),
      elapsedMs,
      timestamp: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
