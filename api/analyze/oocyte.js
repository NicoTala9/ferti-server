import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS_HEADERS).send("");
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { base64, mimeType = "image/jpeg", patientAge = 35, procedureType = "fresco" } = req.body;

    if (!base64) {
      return res.status(400).json({ error: "Missing base64 image" });
    }

    const ageGroup =
      patientAge < 35 ? "<35" :
      patientAge <= 37 ? "35-37" :
      patientAge <= 40 ? "38-40" :
      patientAge <= 42 ? "41-42" : ">42";

    const prompt = `Sos un sistema de IA especializado en evaluación morfológica de ovocitos humanos para medicina reproductiva. Analizás la imagen de un ovocito y devolvés un JSON con predicciones basadas en evidencia científica (ESHRE Istanbul Consensus 2024, SART 2023).

CONTEXTO DEL ANÁLISIS:
- Edad de la paciente: ${patientAge} años (grupo etario: ${ageGroup})
- Tipo de procedimiento: ${procedureType === "crio" ? "Criopreservación (vitrificación)" : "Fresco (FIV/ICSI)"}

CRITERIOS DE EVALUACIÓN MORFOLÓGICA:
Evaluá estos parámetros de la imagen del ovocito:
1. Citoplasma: granularidad, homogeneidad, inclusiones, vacuolas
2. Espacio perivitelino (PVS): tamaño, presencia de gránulos
3. Corpúsculo polar 1 (PB1): integridad, fragmentación, tamaño
4. Zona pelúcida (ZP): grosor, uniformidad, birefringencia

ESCALAS DE REFERENCIA (ESHRE 2024):
- Calidad: Alto / Medio Alto / Medio Bajo / Bajo
- Prob. blastocisto por calidad: Alto 75-85%, Medio Alto 55-70%, Medio Bajo 35-50%, Bajo 15-35%
- Prob. euploide base por grupo etario: <35: 50-60%, 35-37: 40-50%, 38-40: 30-40%, 41-42: 25-35%, >42: 15-25%
- Ajuste por morfología: Alto +5-10%, Medio Alto 0%, Medio Bajo -5-10%, Bajo -10-20%
${procedureType === "crio" ? "- Sobrevida crio (vitrificación): Alto 90-95%, Medio Alto 85-92%, Medio Bajo 78-86%, Bajo 72-82%" : ""}

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones fuera del JSON.

Estructura exacta requerida:
{
  "quality": "Alto|Medio Alto|Medio Bajo|Bajo",
  "blastocystProbability": <número entero 5-95>,
  "euploidyProbability": <número entero 5-75>,
  "survivalProbability": <número entero 50-98>,
  "morphology": {
    "cytoplasm": "<descripción concisa en español>",
    "perivitellineSpace": "<descripción concisa en español>",
    "polarBody": "<descripción concisa en español>",
    "zonaPellucida": "<descripción concisa en español>"
  },
  "notes": "<observación clínica relevante en español, 1-2 oraciones>"
}

Analizá la imagen y devolvé el JSON:`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);

    const result = {
      quality: ["Alto", "Medio Alto", "Medio Bajo", "Bajo"].includes(parsed.quality) ? parsed.quality : "Medio Alto",
      blastocystProbability: Math.min(95, Math.max(5, Math.round(parsed.blastocystProbability || 50))),
      euploidyProbability: Math.min(75, Math.max(5, Math.round(parsed.euploidyProbability || 35))),
      survivalProbability: Math.min(98, Math.max(50, Math.round(parsed.survivalProbability || 88))),
      morphology: {
        cytoplasm: parsed.morphology?.cytoplasm || "Normal",
        perivitellineSpace: parsed.morphology?.perivitellineSpace || "Normal",
        polarBody: parsed.morphology?.polarBody || "Íntegro",
        zonaPellucida: parsed.morphology?.zonaPellucida || "Normal",
      },
      notes: parsed.notes || "",
    };

    return res.status(200).set(CORS_HEADERS).json(result);
  } catch (err) {
    console.error("oocyte analyze error:", err);
    return res.status(500).set(CORS_HEADERS).json({ error: "Analysis failed", detail: err.message });
  }
}
