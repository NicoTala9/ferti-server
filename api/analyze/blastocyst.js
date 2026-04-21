import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { validateBase64 } from "../_lib/validation.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  // BACKEND-011: solo POST/OPTIONS (antes declaraba GET pero lo rechazaba).
  setCORS(req, res);
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!assertAllowedOrigin(req, res)) return;
  if (!(await assertWithinRateLimit(req, res))) return;

  try {
    const { imageBase64, dayOfDevelopment, patientAge, cultureType, linkedOocyte, linkedSperm, linkedClinical } = req.body || {};

    // BACKEND-002: validar payload size ANTES del split (el data URL prefix cuenta poco pero mejor cortarlo).
    if (!validateBase64(imageBase64, res, { fieldName: "imageBase64" })) return;

    const base64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const mimeType = imageBase64.startsWith("data:image/png") ? "image/png" : "image/jpeg";

    // Build context from linked analyses
    let contextSection = "";
    if (linkedOocyte) {
      contextSection += `\nOVOCITO DE ORIGEN (OvoQ):
- Calidad: ${linkedOocyte.quality || "—"}
- Prob. blastocisto predicha: ${linkedOocyte.blastocystProbability || "—"}%
- Prob. euploide predicha: ${linkedOocyte.euploidyProbability || "—"}%`;
    }
    if (linkedSperm) {
      contextSection += `\nANÁLISIS SEMINAL (SpermQ):
- SpermScore: ${linkedSperm.spermScore || "—"}
- Diagnóstico: ${linkedSperm.diagnosis || "—"}
- Morfología: ${linkedSperm.params?.morphology || "—"}%`;
    }
    if (linkedClinical) {
      contextSection += `\nHISTORIA CLÍNICA (ClinicalQ):
- AMH: ${linkedClinical.amh || "—"}
- AFC: ${linkedClinical.afc || "—"}
- Protocolo: ${linkedClinical.protocol || "—"}`;
    }

    const ageGroup = !patientAge ? "desconocida"
      : patientAge < 35 ? "<35 años"
      : patientAge <= 37 ? "35-37 años"
      : patientAge <= 40 ? "38-40 años"
      : patientAge <= 42 ? "41-42 años"
      : ">42 años";

    const prompt = `Sos un embriólogo experto en evaluación morfológica de blastocistos. Analizá la imagen de este blastocisto humano en día ${dayOfDevelopment || 5} de desarrollo.

CONTEXTO CLÍNICO:
- Edad de la paciente: ${patientAge ? `${patientAge} años (${ageGroup})` : "no disponible"}
- Tipo de cultivo: ${cultureType === "individual" ? "Individual" : "Grupal"}
- Día de evaluación: D${dayOfDevelopment || 5}
${contextSection || "- Sin datos de otras apps vinculadas"}

CRITERIOS DE CLASIFICACIÓN GARDNER:
Expansión (1-6):
1: Blastocisto inicial, cavidad <1/2 del volumen
2: Blastocisto, cavidad >1/2 del volumen
3: Blastocisto completo, cavidad llena toda la zona pelúcida
4: Blastocisto expandido, zona pelúcida adelgazada
5: Blastocisto eclosionando (hatching)
6: Blastocisto eclosionado

Masa Celular Interna (ICM - A/B/C):
A: Muchas células compactas y fuertemente unidas
B: Varias células, libremente agrupadas
C: Muy pocas células

Trofoectodermo (TE - A/B/C):
A: Muchas células formando un epitelio cohesivo
B: Pocas células formando un epitelio laxo
C: Muy pocas células grandes

TASAS DE REFERENCIA (Alpha/ESHRE Istanbul Consensus):
- Implantación por Gardner: 4AA/5AA 50-65%, 4AB/4BA 40-55%, 4BB 30-45%, 3AA 35-50%, 2AB/3AB 20-35%, ≤2BB <20%
- Prob. euploide base por grupo etario: <35: 55-65%, 35-37: 45-55%, 38-40: 35-45%, 41-42: 25-35%, >42: 15-25%
- Ajuste por calidad Gardner: AA +10-15%, AB/BA +5%, BB 0%, BC/CB -10%, CC -20%
${linkedOocyte ? `- Ajustar predicciones considerando datos del ovocito de origen` : ""}

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown.

Estructura exacta requerida:
{
  "gardner": {
    "expansion": <número 1-6>,
    "icm": "<A|B|C>",
    "te": "<A|B|C>",
    "grade": "<ej: 4AB>",
    "confidence": "<high|medium|low>"
  },
  "blastoScore": <número 0-100>,
  "quality": "<Alto|Medio|Bajo>",
  "morphology": {
    "innerCellMass": "<descripción concisa en español>",
    "trophectoderm": "<descripción concisa en español>",
    "blastocoel": "<descripción concisa en español>",
    "zonaStatus": "<descripción concisa en español>",
    "fragmentation": "<descripción concisa en español>",
    "symmetry": "<descripción concisa en español>"
  },
  "predictions": {
    "euploidyProbability": <número 5-80>,
    "implantationProbability": <número 5-70>,
    "clinicalPregnancyProbability": <número 5-65>,
    "liveBirthProbability": <número 5-55>
  },
  "recommendation": "<Recomendado para transferencia|Considerar criopreservación o biopsia PGT-A|No recomendado para transferencia>",
  "aiNotes": "<observación clínica relevante en español, 2-3 oraciones>"
}

Analizá la imagen y devolvé el JSON:`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
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

    // Validate and sanitize
    const expansions = [1,2,3,4,5,6];
    const grades = ["A","B","C"];
    const exp = expansions.includes(parsed.gardner?.expansion) ? parsed.gardner.expansion : 4;
    const icm = grades.includes(parsed.gardner?.icm) ? parsed.gardner.icm : "B";
    const te  = grades.includes(parsed.gardner?.te)  ? parsed.gardner.te  : "B";

    const result = {
      gardner: {
        expansion: exp, icm, te,
        grade: `${exp}${icm}${te}`,
        confidence: parsed.gardner?.confidence || "medium",
      },
      blastoScore: Math.min(100, Math.max(0, parseInt(parsed.blastoScore) || 50)),
      quality: ["Alto","Medio","Bajo"].includes(parsed.quality) ? parsed.quality : "Medio",
      morphology: {
        innerCellMass: parsed.morphology?.innerCellMass || "Sin datos",
        trophectoderm: parsed.morphology?.trophectoderm || "Sin datos",
        blastocoel: parsed.morphology?.blastocoel || "Sin datos",
        zonaStatus: parsed.morphology?.zonaStatus || "Sin datos",
        fragmentation: parsed.morphology?.fragmentation || "Sin datos",
        symmetry: parsed.morphology?.symmetry || "Sin datos",
      },
      predictions: {
        euploidyProbability:           Math.min(80, Math.max(5, parseInt(parsed.predictions?.euploidyProbability) || 40)),
        implantationProbability:       Math.min(70, Math.max(5, parseInt(parsed.predictions?.implantationProbability) || 35)),
        clinicalPregnancyProbability:  Math.min(65, Math.max(5, parseInt(parsed.predictions?.clinicalPregnancyProbability) || 30)),
        liveBirthProbability:          Math.min(55, Math.max(5, parseInt(parsed.predictions?.liveBirthProbability) || 25)),
      },
      recommendation: parsed.recommendation || "Evaluar con embriólogo",
      aiNotes: parsed.aiNotes || "",
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error("blastocyst analyze error:", err);
    // BACKEND-006: no exponer err.message al cliente (information leak).
    // Los detalles quedan en console.error para Vercel logs.
    return res.status(500).json({ error: "Analysis failed" });
  }
}
