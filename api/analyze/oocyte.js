import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
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
    const { base64, mimeType = "image/jpeg", patientAge = 35, procedureType = "fresco", clinicStats = null } = req.body;

    if (!base64) {
      return res.status(400).json({ error: "Missing base64 image" });
    }

    const ageGroup =
      patientAge < 35 ? "<35" :
      patientAge <= 37 ? "35-37" :
      patientAge <= 40 ? "38-40" :
      patientAge <= 42 ? "41-42" : ">42";

    // Construir bloque de contexto clínico real si hay datos de la clínica
    let clinicContext = "";
    if (clinicStats && clinicStats[ageGroup] && clinicStats[ageGroup].total >= 5) {
      const cs = clinicStats[ageGroup];
      const globalCs = clinicStats["global"];
      const morphCs = clinicStats["morphology"];

      clinicContext = `
DATOS REALES DE LA CLÍNICA (priorizar sobre referencias bibliográficas):
Grupo etario ${ageGroup} años — n=${cs.total} ovocitos registrados en esta clínica:
- Tasa de blastulación observada: ${cs.blastoRate}% (usar como referencia base para blasto)
- Tasa de euploidía confirmada por PGT-A: ${cs.pgtRate !== null ? cs.pgtRate + "% (n=" + cs.pgtN + ")" : "sin datos PGT suficientes"}
${globalCs ? `- Dataset global clínica: ${globalCs.total} ovocitos, blasto global ${globalCs.blastoRate}%` : ""}
${morphCs ? `
CORRELACIÓN MORFOLOGÍA → RESULTADO REAL EN ESTA CLÍNICA:
${Object.entries(morphCs).map(([q,v]) => `- Calidad ${q} (n=${v.total}): blasto ${v.blastoRate}%${v.pgtRate !== null ? `, euploide PGT ${v.pgtRate}%` : ""}${v.gardnerGoodRate !== null ? `, Gardner ≥4BB ${v.gardnerGoodRate}%` : ""}`).join("\n")}
INSTRUCCIÓN: Cuando evaluás la imagen y determinás la calidad morfológica, usá las tasas de blastulación reales de esta clínica para esa categoría, no los rangos bibliográficos.` : ""}
INSTRUCCIÓN GENERAL: Ajustá las probabilidades usando estos datos reales como ancla principal.`;
    }

    const prompt = `Sos un sistema de IA especializado en evaluación morfológica de ovocitos humanos para medicina reproductiva. Analizás la imagen de un ovocito MII desnudado y devolvés predicciones calibradas basadas en evidencia científica actual.

REFERENCIAS CLÍNICAS:
- ESHRE Istanbul Consensus 2024 (criterios morfológicos)
- SART 2023 (tasas de referencia por edad)
- Murria et al. 2023 (Fertil Steril): CNN en ovocitos 2D → AUC 0.62-0.74 blasto/fertilización
- Mercuri et al. 2024 (Hum Reprod): modelo semi-supervisado → AUC 0.71 ploidía desde imagen
- Fjeldstad et al. 2022 (Hum Reprod): IA no invasiva → AUC 0.70-0.80 euploide
- Drew et al. 2024 (Hum Reprod): reconocimiento de imagen → AUC 0.74 blastulación
${clinicContext}
CONTEXTO DEL ANÁLISIS:
- Edad de la paciente: ${patientAge} años (grupo etario: ${ageGroup})
- Tipo de procedimiento: ${procedureType === "crio" ? "Criopreservación (vitrificación)" : "Fresco (FIV/ICSI)"}

CRITERIOS DE EVALUACIÓN MORFOLÓGICA (Istanbul Consensus 2024):
Evaluá con precisión estos parámetros visibles en la imagen:

1. CITOPLASMA — el predictor más importante de blastulación:
   - Granularidad: homogéneo (óptimo) / granular fino / granular grueso / inclusiones
   - Vacuolas: ausentes (óptimo) / pequeñas periféricas / grandes / múltiples
   - Cuerpos refractarios: ausentes (óptimo) / presentes
   - Agregados de retículo endoplásmico liso (SER): ausentes (óptimo) / presentes → impacto negativo mayor

2. ESPACIO PERIVITELINO (PVS):
   - Tamaño: mínimo (óptimo) / moderado / grande
   - Gránulos: ausentes (óptimo) / presentes → correlaciona negativamente con euploide

3. CORPÚSCULO POLAR 1 (PB1):
   - Morfología: íntegro regular (óptimo) / fragmentado / reabsorbido / gigante
   - Fragmentación PB1 se asocia con aneuploidía en literatura reciente

4. ZONA PELÚCIDA (ZP):
   - Grosor: uniforme normal (óptimo) / delgada / gruesa / irregular
   - Birefringencia: alta (óptimo) / reducida → predictor de fertilización (Polscope)

CALIBRACIÓN DE PROBABILIDADES:
Los modelos de IA actuales tienen AUC 0.62-0.80. Sé conservador y calibrado — no sobreestimes.

Prob. blastocisto base por calidad morfológica:
- Alto: 72-82% | Medio Alto: 52-67% | Medio Bajo: 32-48% | Bajo: 12-30%

Prob. euploide base por grupo etario (SART 2023):
- <35: 48-58% | 35-37: 38-48% | 38-40: 28-38% | 41-42: 20-30% | >42: 12-22%

Ajuste morfológico sobre prob. euploide:
- Citoplasma homogéneo + PVS mínimo + PB1 íntegro + ZP uniforme: +5-8%
- Alteraciones leves (1-2 parámetros): 0%
- Alteraciones moderadas (2-3 parámetros): -5-10%
- Alteraciones severas o SER presente: -10-18%

VARIACIÓN ENTRE OVOCITOS — MUY IMPORTANTE:
Cada ovocito es único. Los valores numéricos DEBEN reflejar exactamente lo que ves en la imagen:
- Si el citoplasma tiene granularidad fina → bajar blasto 3-6% respecto al óptimo
- Si el PVS es moderado → bajar euploide 2-4%
- Si el PB1 está fragmentado → bajar euploide 4-8%
- Si la ZP es irregular o engrosada → bajar blasto 2-5%
- Si todo es óptimo → usar el valor alto del rango
Nunca uses el mismo número para dos ovocitos distintos a menos que sean morfológicamente idénticos en todos los parámetros.
${procedureType === "crio" ? `
Prob. sobrevida vitrificación (ESHRE 2024):
- Alto: 90-95% | Medio Alto: 84-91% | Medio Bajo: 76-84% | Bajo: 68-78%` : ""}

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones fuera del JSON.

CÁLCULO OBLIGATORIO ANTES DE RESPONDER:
1. Identificá la calidad morfológica (Alto/Medio Alto/Medio Bajo/Bajo)
2. Tomá el valor BASE del rango (ej: Medio Alto → blasto base = 59%)
3. Para cada parámetro con alteración, restá exactamente:
   - Granularidad fina: -3% blasto
   - Granularidad gruesa o inclusiones: -8% blasto
   - Vacuolas pequeñas: -4% blasto
   - Vacuolas grandes: -10% blasto
   - PVS moderado: -2% euploide
   - PVS grande: -5% euploide
   - PB1 fragmentado leve: -4% euploide
   - PB1 fragmentado severo: -8% euploide
   - ZP irregular o gruesa: -3% blasto
   - SER presente: -12% blasto, -8% euploide
4. El resultado final = base - suma de penalizaciones. Este DEBE ser el número en el JSON.

Estructura exacta requerida:
{
  "quality": "Alto|Medio Alto|Medio Bajo|Bajo",
  "blastocystProbability": <número entero calculado según las penalizaciones de arriba>,
  "euploidyProbability": <número entero calculado según las penalizaciones de arriba>,
  "survivalProbability": <número entero 50-98>,
  "morphology": {
    "cytoplasm": "<descripción morfológica concisa: granularidad, vacuolas, inclusiones>",
    "perivitellineSpace": "<tamaño y presencia de gránulos>",
    "polarBody": "<integridad y morfología del PB1>",
    "zonaPellucida": "<grosor y uniformidad>",
    "anomalies": "<anomalías relevantes detectadas, o 'Sin anomalías destacables'>"
  },
  "notes": "<observación clínica en español: hallazgo morfológico principal y su implicación pronóstica, 1-2 oraciones>"
}

Analizá la imagen con criterios Istanbul Consensus 2024 y devolvé el JSON:`;

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
        anomalies: parsed.morphology?.anomalies || "Sin anomalías destacables",
      },
      notes: parsed.notes || "",
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error("oocyte analyze error:", err);
    return res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
}
