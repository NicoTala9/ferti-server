import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";
import { bearerFromReq, verifySession } from "../_lib/jwt.js";
import { logSafeError } from "../_lib/logSafe.js";

// POST /api/training/extract-excel · Fase 2 · extracción robusta del Excel de training.
//
// Recibe la planilla como CSV (texto · sin imágenes · liviano) y usa Claude para
// mapear las columnas al schema normalizado SIN depender del orden/nombre exacto
// (roadmap D3). Devuelve un array de ovocitos. Las imágenes y el PGT siguen
// procesándose aparte (client-side / endpoint pgt).
//
// body: { csv: string }
// 200: [{ well, age, treatmentId, gardner, kidScore }, ...]
//      header X-Extract-Status: "ok" | "no_evaluable"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_CSV_BYTES = 256 * 1024; // planillas de un caso son chicas

export default async function handler(req, res) {
  setCORS(req, res);
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!assertAllowedOrigin(req, res)) return;
  if (!(await assertWithinRateLimit(req, res))) return;

  // Auth · cierra el endpoint LLM abierto (audit P0-1). Cualquier usuario autenticado;
  // el permiso de upload y el aislamiento por clínica los enforcean las rules en el write.
  const claims = verifySession(bearerFromReq(req));
  if (!claims || !claims.role) return res.status(401).json({ error: "No autenticado" });

  try {
    const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
    if (!csv.trim()) return res.status(400).json({ error: "csv requerido" });
    if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
      return res.status(413).json({ error: "Planilla demasiado grande" });
    }

    const prompt = `Te paso una planilla (CSV) con datos de ovocitos para entrenar un modelo. Cada fila de datos (salvo encabezados) es un ovocito.

Mapeá cada ovocito a este schema y devolvé SOLO un array JSON:
- well: número identificador del ovocito (columna tipo "well", "pozo", "ovocito", "n°", "id", "óvulo"). Entero.
- age: edad de la paciente ("edad", "age"). Entero, o null.
- treatmentId: identificador del tratamiento/ciclo ("tratamiento", "treatment", "ciclo", "id"). String, o "".
- gardner: grado morfológico Gardner del blastocisto (ej "4AA", "5BB", "3BC"). String, o "" si está vacío / no llegó a blasto.
- kidScore: KID score ("kid", "kidscore", "score"). Número, o null.

REGLAS:
- Detectá las columnas por su ENCABEZADO/significado, sin importar el orden ni el nombre exacto (puede estar en español o inglés, abreviado, etc.).
- Ignorá filas de encabezado y filas vacías.
- Si una columna no existe en la planilla, usá null (o "" para strings).
- well es OBLIGATORIO: si una fila no tiene un número de ovocito claro, omitila.

INSTRUCCIÓN CRÍTICA: respondé ÚNICAMENTE con el array JSON válido, sin markdown ni texto adicional.

Ejemplo:
[
  { "well": 1, "age": 36, "treatmentId": "TX-123", "gardner": "4AA", "kidScore": 7 },
  { "well": 2, "age": 36, "treatmentId": "TX-123", "gardner": "", "kidScore": null }
]

CSV:
${csv}`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn("extract-excel: respuesta no parseable", parseErr?.message);
      res.setHeader("X-Extract-Status", "no_evaluable");
      return res.status(200).json([]);
    }

    const num = (v) => Number(String(v ?? "").replace(",", ".").trim()); // tolera coma decimal es-AR
    const result = (Array.isArray(parsed) ? parsed : []).map((item) => {
      const well = parseInt(item.well);
      const ageNum = num(item.age);
      const kidNum = num(item.kidScore);
      return {
        well: Number.isFinite(well) ? well : null,
        age: Number.isFinite(ageNum) && ageNum > 0 ? ageNum : null, // null (no 0) si falta → no sesga stats
        treatmentId: item.treatmentId != null ? String(item.treatmentId) : "",
        gardner: item.gardner != null ? String(item.gardner).trim() : "",
        kidScore: Number.isFinite(kidNum) && kidNum > 0 ? kidNum : null,
      };
    }).filter((r) => r.well !== null && r.well > 0);

    res.setHeader("X-Extract-Status", result.length > 0 ? "ok" : "no_evaluable");
    return res.status(200).json(result);
  } catch (err) {
    logSafeError("training/extract-excel", err);
    return res.status(500).json({ error: "Extraction failed" });
  }
}
