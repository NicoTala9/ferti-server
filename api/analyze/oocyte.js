import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { validateBase64, validateMimeType, ALLOWED_IMAGE_MIMES } from "../_lib/validation.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";
import { logSafeError } from "../_lib/logSafe.js";
import { predictWithCNN, combineProbs, isCNNEnabled } from "../_lib/cnnClient.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  setCORS(req, res);
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!assertAllowedOrigin(req, res)) return;
  if (!(await assertWithinRateLimit(req, res))) return;

  try {
    // BACKEND-016: aceptamos `clinicStats` en el body para backward-compat con
    // clientes que aún lo mandan, pero NO lo reinyectamos en el prompt a Anthropic.
    // Mandar tasas reales de la clínica a un proveedor externo (aunque no identifique
    // pacientes individuales) filtra métricas operativas sensibles. El calibrado por
    // clínica, si hace falta recuperarlo, se hace server-side post-respuesta, no
    // enviando los números al modelo. Ver docs/AUDIT/00-SUMMARY.md → BACKEND-016.
    const { base64, mimeType = "image/jpeg", patientAge = 35, procedureType = "fresco" } = req.body;

    // BACKEND-002 / BACKEND-005: validar payload size + mime whitelist
    if (!validateBase64(base64, res)) return;
    if (!validateMimeType(mimeType, ALLOWED_IMAGE_MIMES, res)) return;

    const ageGroup =
      patientAge < 35 ? "<35" :
      patientAge <= 37 ? "35-37" :
      patientAge <= 40 ? "38-40" :
      patientAge <= 42 ? "41-42" : ">42";

    // Sin clinicContext: el prompt queda anclado exclusivamente a referencias bibliográficas.
    const clinicContext = "";

    const prompt = `Sos un sistema de IA especializado en evaluación morfológica de ovocitos humanos para medicina reproductiva. Analizás la imagen de un ovocito MII desnudado y devolvés predicciones calibradas basadas en evidencia científica actual.

CHEQUEO PREVIO DE EVALUABILIDAD (OBLIGATORIO — HACER ANTES DE LA EVALUACIÓN MORFOLÓGICA):
Antes de aplicar los criterios Istanbul Consensus, verificá que la imagen sea realmente un ovocito humano en vista de microscopía evaluable. Devolvé status: "no_evaluable" si se cumple CUALQUIERA de estas condiciones:
- La imagen NO es una imagen de microscopía de un ovocito (ej: logo, captura de pantalla, texto, foto cualquiera, paisaje, documento escaneado, imagen sólida negra/blanca/roja, ruido aleatorio, 1x1 pixel, ilustración, dibujo, etc).
- Hay un ovocito pero está totalmente fuera de foco y no se distinguen membrana citoplasmática, PVS o PB1.
- La imagen está tan sobreexpuesta o subexpuesta que no se puede evaluar citoplasma (todo blanco o todo negro).
- El encuadre no permite ver la zona pelúcida completa ni el citoplasma interno.
- Hay múltiples ovocitos superpuestos sin uno claramente discriminable.
- No podés identificar con alta confianza que lo que ves es un ovocito MII.

REGLA DE ORO: Ante cualquier duda → status: "no_evaluable". NO inventes morfología. NO completes probabilidades con valores por defecto. Es MEJOR rechazar que alucinar.

Si status = "no_evaluable": dejar en null los campos quality, blastocystProbability, euploidyProbability, survivalProbability, morphology y notes. Sólo completar rejectionReason con el motivo específico.

Si status = "evaluable": completar TODO el análisis siguiendo los criterios de abajo.

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

EVIDENCIA CIENTÍFICA RECIENTE Y CONTEXTO BIOLÓGICO (para calibrar tus predicciones):

1. OOPLASMA ES LA VARIABLE MÁS PREDICTIVA (Fjeldstad et al. 2024, Scientific Reports): la textura del ooplasma contiene la mayor parte de la información predictiva de desarrollo a blastocisto. Cuando se removieron las features del citoplasma de un modelo de IA, la capacidad predictiva cayó significativamente (AUC de 0.63 a 0.57). Las variables extracitoplásmicas (zona pelúcida, espacio perivitelino) aportan menos. Priorizá la evaluación de: granularidad del citoplasma, homogeneidad, vacuolas, cuerpos refráctiles, agregados de SER, y distribución general del ooplasma.

2. LA MORFOLOGÍA DEL OVOCITO PREDICE EUPLOIDÍA (Mercuri et al. 2024, ESHRE O-004): un modelo de IA predijo el resultado de PGT-A del blastocisto resultante desde la imagen del ovocito con AUC 0.71, superando a la edad como predictor. Esto valida que las probabilidades de euploide basadas en morfología ovocitaria tienen sustento científico. No subestimes la capacidad predictiva de la morfología ovocitaria sobre la ploidía.

3. CORRELACIÓN CON CALIDAD DEL BLASTOCISTO (Fjeldstad et al. 2024, RBMO): ovocitos con score alto no solo tienen mayor probabilidad de llegar a blastocisto sino que correlacionan con mejor calidad de blastocisto (mayor expansión, mejor clasificación Gardner). Un ovocito clasificado como de alta calidad tiene aproximadamente 2.6 veces más probabilidad de desarrollar un blastocisto que uno de baja calidad.

4. FACTOR MASCULINO (Borges et al. 2025, F&S Science · Fjeldstad et al. 2024, RBMO): el factor masculino severo tiene impacto negligible en la capacidad predictiva del modelo de ovocitos. La calidad del ovocito predice blastulación independientemente de la calidad del semen. Si hay datos de SpermAI vinculados con DFI elevado (>25%) o morfología muy baja (<2%), ajustá la probabilidad de fecundación, NO la de blastulación.

5. PREDICCIÓN DE COHORTE (Fjeldstad et al. 2024, Scientific Reports): la suma de scores individuales de los ovocitos de un caso predice la formación de 2+ blastocistos utilizables con AUC 0.77 — significativamente mejor que la predicción individual. Cuando analices múltiples ovocitos del mismo caso, además del score individual considerá el pronóstico de la cohorte completa.

CONTEXTO BIOLÓGICO PARA CALIBRACIÓN:

La ploidía del embrión se determina mayoritariamente durante la meiosis del ovocito, ANTES de la fecundación. Los errores cromosómicos (aneuploidías) ocurren durante la separación de cromosomas en la maduración ovocitaria y dejan señales morfológicas visibles. La llegada a blastocisto, en cambio, depende también de variables POST-fecundación que NO se ven en la imagen del ovocito: calidad del espermatozoide, técnica de ICSI, condiciones de cultivo, medio, temperatura.

IMPLICANCIA: tus predicciones de euploide basadas en morfología ovocitaria tienen mayor sustento que tus predicciones de blastulación. Sé más assertivo con las probabilidades de euploide (la señal está en la imagen) y más conservador con las de blastulación (hay variables que no podés ver). Esto es consistente con la literatura: los modelos publicados logran AUC ~0.71 en euploide vs ~0.64 en blastulación con este enfoque.

SEÑALES MORFOLÓGICAS DE ANEUPLOIDÍA OVOCITARIA (priorizá detectarlas):
- Citoplasma granuloso central (no periférico) → mayor riesgo de aneuploidía
- Agregados de SER (smooth endoplasmic reticulum) → riesgo elevado · impacto negativo mayor en euploide
- Corpúsculo polar fragmentado o muy grande → posible error meiótico
- Vacuolas citoplasmáticas grandes (>14μm) → asociadas a peor pronóstico genético
- Zona pelúcida muy gruesa o irregular → asociada a menor competencia ovocitaria
- Espacio perivitelino con abundante debris → posible indicador de estrés celular

SEÑALES DE BUENA COMPETENCIA OVOCITARIA:
- Citoplasma homogéneo, levemente granuloso (textura fina uniforme)
- Corpúsculo polar intacto, tamaño normal, redondo
- Zona pelúcida uniforme, grosor normal
- Espacio perivitelino limpio, pequeño
- Forma esférica simétrica
- Ausencia de vacuolas y SER

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

Si la imagen NO es evaluable (falló el CHEQUEO PREVIO):
{
  "status": "no_evaluable",
  "rejectionReason": "<motivo específico en español, ej: 'La imagen no corresponde a un ovocito en microscopía', 'Imagen fuera de foco', 'Sobreexposición impide evaluar citoplasma', 'Encuadre incompleto', 'Imagen sólida sin contenido', etc>",
  "quality": null,
  "blastocystProbability": null,
  "euploidyProbability": null,
  "survivalProbability": null,
  "morphology": null,
  "notes": null
}

Si la imagen ES evaluable:
{
  "status": "evaluable",
  "rejectionReason": null,
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

    // M#3 phase 2 · Claude + CNN en paralelo · Promise.all evita serializar
    // latencia (Claude ~1.8s · CNN ~1.5s · paralelo = max(ambos) ~1.8s en vez
    // de 3.3s). CNN failure NO aborta Claude (Promise.all resolverá lo que
    // tenga · predictWithCNN ya devuelve null en error · no rejected promise).
    const [response, cnnResult] = await Promise.all([
      client.messages.create({
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
      }),
      // CNN call · si flag off o falla · returns null y el código abajo
      // fallbackea silently a Claude-only (zero crash UX).
      predictWithCNN(base64, patientAge),
    ]);

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);

    // SEC-adversarial: si Claude marcó la imagen como no evaluable, respetar la decisión.
    // NO forzamos fallback a "Medio Alto" porque eso alucinaba análisis sobre imágenes basura
    // (logos, 1x1 pixels, capturas de pantalla, etc). Mejor devolver status explícito al cliente.
    if (parsed.status === "no_evaluable") {
      return res.status(200).json({
        status: "no_evaluable",
        rejectionReason: parsed.rejectionReason || "La imagen no es evaluable como ovocito",
        quality: null,
        blastocystProbability: null,
        euploidyProbability: null,
        survivalProbability: null,
        morphology: null,
        notes: null,
      });
    }

    // Probs base de Claude (clamped a rangos clínicamente razonables · evita
    // outliers extremos por aluciación).
    const claudeBlasto = Math.min(95, Math.max(5, Math.round(parsed.blastocystProbability || 50)));
    const claudeEuploide = Math.min(75, Math.max(5, Math.round(parsed.euploidyProbability || 35)));

    // M#3 phase 2 · combinación Claude + CNN 50/50 cuando CNN responde OK.
    // Si cnnResult === null (flag off · timeout · 5xx · etc) · usa solo Claude.
    // El combine es server-side · el cliente recibe UN solo número combinado y
    // no se entera de la arquitectura interna (encapsulación · futuro: cambiar
    // pesos por clínica vía Smart Prompting sin tocar el cliente).
    const finalBlasto = cnnResult
      ? combineProbs(claudeBlasto, cnnResult.blastoProb)
      : claudeBlasto;
    const finalEuploide = cnnResult
      ? combineProbs(claudeEuploide, cnnResult.euploideProb)
      : claudeEuploide;

    const result = {
      status: "evaluable",
      rejectionReason: null,
      quality: ["Alto", "Medio Alto", "Medio Bajo", "Bajo"].includes(parsed.quality) ? parsed.quality : "Medio Alto",
      blastocystProbability: finalBlasto,
      euploidyProbability: finalEuploide,
      survivalProbability: Math.min(98, Math.max(50, Math.round(parsed.survivalProbability || 88))),
      morphology: {
        cytoplasm: parsed.morphology?.cytoplasm || "Normal",
        perivitellineSpace: parsed.morphology?.perivitellineSpace || "Normal",
        polarBody: parsed.morphology?.polarBody || "Íntegro",
        zonaPellucida: parsed.morphology?.zonaPellucida || "Normal",
        anomalies: parsed.morphology?.anomalies || "Sin anomalías destacables",
      },
      notes: parsed.notes || "",
      // Diagnóstico · qué motor produjo la predicción. Útil para QA + post-mortem
      // accuracy tracking · Roadmap §6.1. NO contiene info sensible (sin imagen
      // ni edad) · OK exponer al cliente.
      modelMeta: {
        cnnEnabled: isCNNEnabled(),
        cnnUsed: !!cnnResult,
        modelVersion: cnnResult?.modelVersion || "claude-only",
        cnnInferenceMs: cnnResult?.inferenceMs || null,
      },
    };

    return res.status(200).json(result);
  } catch (err) {
    // BACKEND-006: no exponer err.message al cliente (information leak).
    // BACKEND-012: logSafeError scrubea PII (nada de raw req.body ni err.cause).
    logSafeError("analyze/oocyte", err);
    return res.status(500).json({ error: "Analysis failed" });
  }
}
