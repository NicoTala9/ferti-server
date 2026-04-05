import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { base64, mimeType = "image/png" } = req.body;
    if (!base64) return res.status(400).json({ error: "Missing base64 image" });

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
    const parsed = JSON.parse(jsonStr);

    // Sanitizar
    const result = (Array.isArray(parsed) ? parsed : []).map(item => ({
      embryoId: String(item.embryoId || ""),
      wellNumber: parseInt(item.wellNumber) || null,
      result: ["euploide","aneuploide","mosaico"].includes(item.result) ? item.result : null,
      sex: ["XX","XY"].includes(item.sex) ? item.sex : null,
      chromosomes: item.chromosomes || "-",
      interpretation: item.interpretation || "",
    })).filter(item => item.wellNumber !== null);

    return res.status(200).json(result);
  } catch (err) {
    console.error("pgt analyze error:", err);
    return res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
}
