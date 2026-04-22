import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { validateBase64, validateMimeType, ALLOWED_IMAGE_MIMES } from "../_lib/validation.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  setCORS(req, res);
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!assertAllowedOrigin(req, res)) return;
  if (!(await assertWithinRateLimit(req, res))) return;

  try {
    const { base64, mimeType = "image/png" } = req.body || {};

    // BACKEND-002 / BACKEND-005: validar payload size + mime whitelist
    if (!validateBase64(base64, res)) return;
    if (!validateMimeType(mimeType, ALLOWED_IMAGE_MIMES, res)) return;

    const prompt = `Analizá esta imagen que contiene una tabla de resultados de PGT-A (test genético preimplantacional de aneuploidías).

Extraé cada fila de la tabla y devolvé un array JSON con los datos de cada embrión.

Para cada embrión extraé:
- embryoId: el código del embrión tal como aparece en la tabla (ej: "ABQ1", "ABH6")
- wellNumber: el NÚMERO que aparece al final del ID del embrión (ej: ABQ1 → 1, ABH6 → 6, ABQ12 → 12). Extraé solo el número final.
- result: el resultado normalizado. Usá EXACTAMENTE uno de estos valores:
  - "euploide" si dice Euploide, Normal, Euploid, o similar
  - "aneuploide" si dice Aneuploide, Aneuploid, Anormal, o similar
  - "mosaico" si dice Mosaico, Mosaic, o cualquier variante con mosaico
- sex: "XX" o "XY" tal como aparece en la tabla. null si no hay.
- chromosomes: los cromosomas implicados tal como aparecen en la tabla, "-" si no hay alteraciones
- interpretation: la interpretación o comentario tal como aparece en la tabla

REGLAS IMPORTANTES:
- Si una fila no tiene resultado claro, igual la incluí con result: null
- El wellNumber es SIEMPRE el número al final del ID del embrión, no el número de fila
- Si el ID es "ABQ10", el wellNumber es 10
- Si el ID es "ABQ1", el wellNumber es 1 (no confundir con 10, 11, etc.)

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, sin explicaciones fuera del JSON.

Ejemplo de respuesta:
[
  { "embryoId": "ABQ1", "wellNumber": 1, "result": "euploide", "sex": "XX", "chromosomes": "-", "interpretation": "Normal" },
  { "embryoId": "ABQ3", "wellNumber": 3, "result": "aneuploide", "sex": "XY", "chromosomes": "+21", "interpretation": "Anormal" },
  { "embryoId": "ABQ6", "wellNumber": 6, "result": "mosaico", "sex": "XX", "chromosomes": "mos+7", "interpretation": "Mosaico parcial de bajo grado" }
]`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          { type: "text", text: prompt },
        ],
      }],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    // BACKEND-024: si el parseo falla, es imagen no evaluable (no es un 500 real).
    // Infra failures (timeout/5xx de Anthropic) sí caen al catch externo.
    // Mantenemos contrato array-root para compat con callers existentes: array vacío = no_evaluable.
    // Los callers que quieran mostrar mensaje pueden leer el header X-Analysis-Status.
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn("pgt analyze: respuesta no parseable, devolviendo no_evaluable", parseErr?.message);
      res.setHeader("X-Analysis-Status", "no_evaluable");
      return res.status(200).json([]);
    }

    // Sanitizar
    const result = (Array.isArray(parsed) ? parsed : []).map(item => ({
      embryoId: String(item.embryoId || ""),
      wellNumber: parseInt(item.wellNumber) || null,
      result: ["euploide","aneuploide","mosaico"].includes(item.result) ? item.result : null,
      sex: ["XX","XY"].includes(item.sex) ? item.sex : null,
      chromosomes: item.chromosomes || "-",
      interpretation: item.interpretation || "",
    })).filter(item => item.wellNumber !== null);

    res.setHeader("X-Analysis-Status", result.length > 0 ? "evaluable" : "no_evaluable");
    return res.status(200).json(result);
  } catch (err) {
    console.error("pgt analyze error:", err);
    // BACKEND-006: no exponer err.message al cliente (information leak).
    // Los detalles quedan en console.error para Vercel logs.
    return res.status(500).json({ error: "Analysis failed" });
  }
}
