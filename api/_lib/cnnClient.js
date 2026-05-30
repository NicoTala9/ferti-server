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
// Latency target · p95 ~2-3s con instance warm. Timeout duro 60s para cubrir
// cold start de Cloud Run con scale-to-zero (12 modelos + TF init ~30-35s) ·
// si timeout · fallback Claude-only. Cuando flipemos a min_instances=1 esto
// se puede bajar a 10s.

const CNN_TIMEOUT_MS = 60000;

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
 * Combina prob Claude + prob CNN · ambos inputs en escala 0-100 o 0-1.
 * Pesos actualizados 2026-05-14 (segunda iteración) · 70% Claude / 30% CNN.
 *
 * Rationale (evidencia · audit 4 imágenes):
 *   Probamos 4 ovocitos con outcomes conocidos (2 positivos, 2 negativos):
 *     Claude blasto · positivos 66-73 ↔ negativos 51-59 · spread 7-22pp ✅
 *     CNN blasto · positivos 47-51 ↔ negativos 47-48 · spread 0-4pp ❌
 *   La CNN blasto está saturada cerca de 0.50 · no discrimina extremos.
 *   La CNN euploide discrimina ligeramente mejor (spread 5-12pp) pero
 *   también más débil que Claude (11-32pp).
 *
 * Hipótesis · 984 casos CEGYR retro podrían no ser suficientes para que
 * la CNN aprenda discriminación significativa, especialmente blasto que
 * depende de variables POST-fecundación no visibles en el ovocito.
 *
 * Acción · Claude domina (70%) · CNN como second-opinion leve (30%).
 * Si batch validation prospectiva (>50 casos) muestra CNN AUC > Claude,
 * revertir. Si la cnn AUC sigue baja · considerar Claude-only o re-train
 * con dataset más grande.
 *
 * Tolera input mixto · detecta escala por magnitud.
 * Si solo uno válido · returns ese (sin re-weight).
 *
 * @param {number} claudeProb  Probabilidad Claude (escala 0-100 esperada)
 * @param {number} cnnProb     Probabilidad CNN (escala 0-1 del backend)
 * @param {number} w           Peso de Claude (default 0.7 · 30% CNN)
 * @returns {number}           Probabilidad combinada en escala 0-100 entero
 */
export function combineProbs(claudeProb, cnnProb, w = 0.7) {
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
