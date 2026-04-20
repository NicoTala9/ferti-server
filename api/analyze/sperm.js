import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertAllowedOrigin(req, res)) return;

  try {
    const { base64, mimeType = "image/jpeg" } = req.body;

    if (!base64) {
      return res.status(400).json({ error: "Missing base64 file" });
    }

    const isDocument = mimeType === "application/pdf";

    const prompt = `Sos un sistema de IA especializado en extracción de datos de espermogramas para medicina reproductiva. Analizás el documento/imagen de un informe de análisis seminal y extraés los valores numéricos de los parámetros según la OMS 2021 (6ª edición).

PARÁMETROS A EXTRAER:
1. concentration — Concentración espermática (mill/mL). Valor de referencia OMS: ≥16
2. progressiveMotility — Motilidad progresiva PR (%). Valor de referencia OMS: ≥30
3. totalMotility — Motilidad total PR+NP (%). Valor de referencia OMS: ≥42
4. morphology — Morfología normal según Kruger (%). Valor de referencia OMS: ≥4
5. vitality — Vitalidad / viabilidad espermática (%). Valor de referencia OMS: ≥54
6. volume — Volumen del eyaculado (mL). Valor de referencia OMS: ≥1.4
7. dfi — Índice de fragmentación del ADN espermático DFI (%). Valor de referencia: ≤25. Este parámetro NO siempre está presente en los informes.

INSTRUCCIONES:
- Buscá los valores en el documento/imagen. Pueden estar en tablas, texto libre, o formatos variados.
- Si un valor aparece claramente → confidence: "high"
- Si el valor es ambiguo, borroso o podrías estar confundiendo con otro dato → confidence: "medium"
- Si el valor NO aparece en el documento o no lo podés identificar → confidence: "low" y value: null
- Para DFI: si no aparece en el informe, poné confidence: "low" y value: null (es normal que no esté)
- Si ves valores como "motilidad tipo a" y "tipo b" por separado, sumá a+b para progressiveMotility
- Si ves "motilidad total" que incluye inmóviles, restá los inmóviles para obtener totalMotility
- Extraé SOLO números, sin unidades ni texto adicional en el campo value

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones fuera del JSON.

Estructura exacta requerida:
{
  "concentration": { "value": <número|null>, "confidence": "high|medium|low" },
  "progressiveMotility": { "value": <número|null>, "confidence": "high|medium|low" },
  "totalMotility": { "value": <número|null>, "confidence": "high|medium|low" },
  "morphology": { "value": <número|null>, "confidence": "high|medium|low" },
  "vitality": { "value": <número|null>, "confidence": "high|medium|low" },
  "volume": { "value": <número|null>, "confidence": "high|medium|low" },
  "dfi": { "value": <número|null>, "confidence": "high|medium|low" },
  "notes": "<observaciones relevantes sobre el informe en español>"
}

Analizá el documento y devolvé el JSON:`;

    const contentBlock = isDocument
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            contentBlock,
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);

    const PARAMS = ["concentration", "progressiveMotility", "totalMotility", "morphology", "vitality", "volume", "dfi"];
    const result = { notes: parsed.notes || "" };

    for (const key of PARAMS) {
      const p = parsed[key];
      if (p && p.value !== null && p.value !== undefined) {
        result[key] = {
          value: Math.round(parseFloat(p.value) * 100) / 100,
          confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "medium",
        };
      } else {
        result[key] = { value: null, confidence: "low" };
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("sperm analyze error:", err);
    return res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
}
