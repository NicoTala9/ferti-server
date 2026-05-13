// M#3 phase 2 · cliente HTTP del CNN inference service (Cloud Run).
// ─────────────────────────────────────────────────────────────────────────────
// Llamado desde /api/analyze/oocyte en paralelo con Claude. Si falla por
// cualquier motivo (timeout, 5xx, network error) returns null → caller hace
// fallback Claude-only (zero crash · log warn server-side).
//
// Config vía env vars Vercel:
//   - CNN_INFERENCE_URL  → https://cnn-inference-xxxx.run.app
//   - CNN_API_TOKEN      → bearer token compartido (mismo valor en Cloud Run)
//   - CNN_ENABLED        → "true" activa · cualquier otra cosa = disabled
//
// Latency target · p95 ~2s incluyendo network. Timeout duro 8s (cubre cold
// start residual + inferencia 12 modelos). Si timeout · fallback Claude-only.

const CNN_TIMEOUT_MS = 8000;

export function isCNNEnabled() {
  return process.env.CNN_ENABLED === "true";
}

/**
 * Llama al servicio CNN Cloud Run · returns { blastoProb, euploideProb,
 * modelVersion, weights, raw, inferenceMs } | null en caso de error.
 *
 * @param {string} base64    Imagen base64 (sin prefijo data: o con · ambos OK)
 * @param {number} edad      Edad paciente en años
 * @returns {Promise<object|null>}
 */
export async function predictWithCNN(base64, edad) {
  if (!isCNNEnabled()) return null;

  const url = process.env.CNN_INFERENCE_URL;
  const token = process.env.CNN_API_TOKEN;
  if (!url || !token) {
    console.warn("[cnnClient] CNN_INFERENCE_URL or CNN_API_TOKEN missing · skipping CNN");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CNN_TIMEOUT_MS);

  try {
    const resp = await fetch(`${url}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ imagen_base64: base64, edad: Number(edad) || 35 }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[cnnClient] HTTP ${resp.status} · ${body.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    // Validación defensiva · si la response no tiene los campos esperados,
    // tratar como fallo · evita inyectar undefined al pipeline downstream.
    if (
      typeof data.blastoProb !== "number" ||
      typeof data.euploideProb !== "number" ||
      !Number.isFinite(data.blastoProb) ||
      !Number.isFinite(data.euploideProb)
    ) {
      console.warn("[cnnClient] invalid response shape", JSON.stringify(data).slice(0, 200));
      return null;
    }
    return data;
  } catch (e) {
    // AbortError (timeout) · network error · DNS fail · todos cae acá.
    console.warn(`[cnnClient] predict failed · ${e?.name || "error"}: ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Combina prob Claude + prob CNN 50/50 · ambos inputs en escala 0-100 o 0-1.
 * Tolera input mixto · detecta escala por magnitud.
 * Si solo uno válido · returns ese (sin re-weight).
 *
 * @param {number} claudeProb  Probabilidad Claude (escala 0-100 esperada)
 * @param {number} cnnProb     Probabilidad CNN (escala 0-1 del backend)
 * @param {number} w           Peso de Claude (default 0.5)
 * @returns {number}           Probabilidad combinada en escala 0-100 entero
 */
export function combineProbs(claudeProb, cnnProb, w = 0.5) {
  const c = Number(claudeProb);
  // CNN service retorna 0-1 · escalamos a 0-100 para combinar
  const n = Number.isFinite(Number(cnnProb)) ? Number(cnnProb) * 100 : NaN;
  const validC = Number.isFinite(c);
  const validN = Number.isFinite(n);
  if (validC && validN) return Math.round(c * w + n * (1 - w));
  if (validC) return Math.round(c);
  if (validN) return Math.round(n);
  return 0;
}
