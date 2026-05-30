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
    const { base64, mimeType = "image/jpeg", patientAge = 35, procedureType = "fresco", language: rawLang = "es" } = req.body;
    // i18n · idioma del análisis · ES default · solo aceptamos ES/EN para evitar
    // prompt-injection vía locale field. Claude responde TODOS los free-text
    // fields (morphology, notes, rejectionReason) en este idioma.
    const language = (rawLang === "en") ? "en" : "es";

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

    // i18n · directiva de idioma para los free-text fields de la respuesta.
     // El prompt principal queda en español (mejor calidad técnica · es la lengua
     // en la que se afinó · cambiar a EN degradaría adherencia al SISTEMA DE
     // SCORING). Solo los OUTPUT free-text fields cambian de idioma.
    const langDirective = language === "en"
      ? `\n\nLANGUAGE OF OUTPUT: Respond with all free-text fields (morphology.cytoplasm, morphology.perivitellineSpace, morphology.polarBody, morphology.zonaPellucida, morphology.anomalies, notes, rejectionReason) IN ENGLISH. The JSON keys and enum values (quality: "Alto"|"Medio Alto"|"Medio Bajo"|"Bajo", status: "evaluable"|"no_evaluable") remain EXACTLY as specified — do NOT translate them. Only translate human-readable descriptions.`
      : `\n\nIDIOMA DE LA RESPUESTA: Respondé los free-text fields (morphology.*, notes, rejectionReason) en ESPAÑOL.`;

    const prompt = `Sos un sistema de IA especializado en evaluación morfológica de ovocitos humanos para medicina reproductiva. Analizás la imagen de un ovocito MII desnudado y devolvés predicciones calibradas basadas en evidencia científica actual.${langDirective}

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

SISTEMA DE SCORING MORFOLÓGICO — CONTINUO, NO BUCKETED:
Tu output NO debe ser bucketeado por calidad ("todos los Medio Alto = 58%"). Cada ovocito
es único · si difieren en CUALQUIER parámetro morfológico (aunque sea sutilmente), los
números DEBEN diferir mínimo 2-3pp. La variación es OBLIGATORIA · ovocitos morfológicamente
idénticos son extremadamente raros · si te encontrás dando el mismo número a dos ovocitos
distintos, RE-EVALUÁ los detalles finos.

PASO 1 · Scoring por parámetro (escala 0-10 continua · USÁ TODA la escala):
- Citoplasma (peso 60% · MÁS predictivo según Fjeldstad 2024 · ooplasma carga
  mayoría de la señal · AUC drop 0.63→0.57 al removerlo):
    10 = homogéneo perfecto · 8 = granularidad fina muy leve · 6 = granularidad fina
    moderada · 4 = granularidad gruesa o vacuolas pequeñas · 2 = SER presente o vacuolas
    grandes · 0 = inclusiones múltiples o citoplasma severamente alterado
- Espacio perivitelino · PVS (peso 18% · señal de euploide · Mercuri 2024):
    10 = mínimo limpio · 8 = mínimo con leve debris · 6 = moderado limpio · 4 = moderado
    granular · 2 = grande con debris · 0 = enorme/severamente alterado
- Corpúsculo polar 1 · PB1 (peso 12%):
    10 = íntegro tamaño normal · 8 = íntegro tamaño leve atípico · 6 = leve fragmentación
    · 4 = fragmentación moderada · 2 = muy fragmentado o gigante · 0 = ausente/reabsorbido
- Zona pelúcida · ZP (peso 10%):
    10 = uniforme grosor normal · 8 = uniforme leve variación · 6 = leve irregularidad
    · 4 = engrosada o irregular · 2 = muy irregular/septos · 0 = colapsada/dañada

PASO 2 · Score morfológico final = suma ponderada (resultado 0-10):
    morphScore = (citoplasma × 0.60) + (PVS × 0.18) + (PB1 × 0.12) + (ZP × 0.10)

PASO 3 · Mapeá a quality category (informativo · pero el número de probabilidad NO lo
toma de acá · lo calculás en paso 4-5):
    morphScore ≥ 8.5: "Alto"
    morphScore 6.5-8.4: "Medio Alto"
    morphScore 4.5-6.4: "Medio Bajo"
    morphScore < 4.5: "Bajo"

PASO 4 · Probabilidad de blastulación (continua):
    Base etaria blasto (SART 2023):
    - <35: 60% | 35-37: 55% | 38-40: 50% | 41-42: 42% | >42: 32%

    Modificador morfológico continuo:
    modBlasto = (morphScore - 5.5) × 4
    (score 10 → +18 · score 5.5 → 0 · score 0 → -22)

    blastoProb = base_etaria_blasto + modBlasto
    (clamped luego al rango 5-95)

PASO 5 · Probabilidad de euploide (continua):
    Base etaria euploide (SART 2023):
    - <35: 53% | 35-37: 43% | 38-40: 33% | 41-42: 25% | >42: 17%

    Modificador morfológico continuo:
    modEuploide = (morphScore - 5.5) × 3
    (score 10 → +13.5 · score 5.5 → 0 · score 0 → -16.5)

    Ajustes adicionales (SOLO si detectás claramente · acumulan):
    - SER presente: -8 puntos extra
    - PB1 muy fragmentado (score PB1 ≤ 3): -5 puntos extra
    - Citoplasma granuloso CENTRAL marcado (no periférico): -3 puntos extra

    euploideProb = base_etaria_euploide + modEuploide + ajustes_adicionales
    (clamped luego al rango 5-75)

REGLA DE VARIACIÓN OBLIGATORIA:
Cada vez que analizás un ovocito, el morphScore debe reflejar diferencias finas. Si ves
un ovocito con citoplasma "homogéneo, sin anomalías" pero con leve sombra de granularidad
periférica · ese es 8 (no 10). Si otro tiene citoplasma "homogéneo sin anomalías" y
absolutamente uniforme · ese es 9 o 10. Esa diferencia (8 vs 9) genera 4 puntos de
diferencia en blasto · suficiente para distinguir. Tu trabajo es CAPTURAR estas diferencias.
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

CÁLCULO OBLIGATORIO ANTES DE RESPONDER (sistema continuo del SISTEMA DE SCORING):
1. Scoring por parámetro (usá DECIMALES · escala 0.0-10.0 con paso 0.5 mínimo):
   citoplasma_score = ?.?, pvs_score = ?.?, pb1_score = ?.?, zp_score = ?.?
   Los 4 deben aparecer EXPLÍCITAMENTE en el JSON como números decimales.
2. morphScore = (citoplasma_score × 0.60) + (pvs_score × 0.18) + (pb1_score × 0.12) + (zp_score × 0.10)
   Resultado con 1 decimal. Debe aparecer en el JSON.
3. quality (informativo) según ranges arriba
4. blastoProb = base_etaria_blasto + (morphScore - 5.5) × 4
5. euploideProb = base_etaria_euploide + (morphScore - 5.5) × 3 + ajustes_adicionales
6. Redondeá a entero. Clamp final blasto [5-95] · euploide [5-75].

REGLAS ANTI-ANCHORING (CRÍTICAS · violarlas devuelve análisis inútil):

A. PROHIBIDO devolver los siguientes valores "ancla" para blastoProb (a menos que
   tu morphScore matemáticamente te dé exactamente ese número):
   50, 55, 58, 60, 62, 65, 70. Si tu cálculo natural pasa por ahí, perturbalo
   ±1 según el detalle morfológico más relevante que viste.

B. PROHIBIDO devolver los siguientes valores "ancla" para euploideProb:
   30, 33, 35, 38, 40, 43, 45. Misma regla · perturbá ±1.

C. PROHIBIDO usar el mismo morphScore para dos ovocitos sucesivos · cada ovocito
   tiene una historia visual única · si te encontrás dando exactamente "7.0" otra
   vez, MIRÁ DE NUEVO el citoplasma · ¿hay leve textura periférica más marcada?
   ¿granos más distribuidos? ¿algún halo en la zona pelúcida? Eso cambia el score
   en al menos 0.5. La variación es OBLIGATORIA · ovocitos morfológicamente
   idénticos al pixel son extremadamente raros.

D. USÁ decimales en los sub-scores. Un citoplasma "muy bueno con leve granularidad
   periférica" es 8.5 · no 9 ni 8. Un PVS "moderado pero limpio" es 6.5 · no 6 ni 7.
   Tu morphScore final puede tener 1 decimal (ej. 7.3, 8.1, 6.7).

E. Si al evaluar te encontrás dudando entre dos sub-scores adyacentes (ej. ¿es 7 u 8?),
   elegí 7.5 o ajustá con ±0.2 según cuál parámetro te llama más la atención.

Estructura exacta requerida:

Si la imagen NO es evaluable (falló el CHEQUEO PREVIO):
{
  "status": "no_evaluable",
  "rejectionReason": "<specific reason in the OUTPUT LANGUAGE specified at the top, e.g.: 'Image does not correspond to a microscopy oocyte', 'Out-of-focus image', 'Overexposure prevents cytoplasm evaluation', 'Incomplete framing', 'Solid image with no content', etc>",
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
  "scores": {
    "citoplasma_score": <decimal 0.0-10.0 con 1 decimal · obligatorio>,
    "pvs_score": <decimal 0.0-10.0 con 1 decimal · obligatorio>,
    "pb1_score": <decimal 0.0-10.0 con 1 decimal · obligatorio>,
    "zp_score": <decimal 0.0-10.0 con 1 decimal · obligatorio>,
    "morphScore": <decimal 0.0-10.0 calculado como suma ponderada · 1 decimal>
  },
  "quality": "Alto|Medio Alto|Medio Bajo|Bajo",
  "blastocystProbability": <número entero · regla A anti-anchoring · respetá morphScore>,
  "euploidyProbability": <número entero · regla B anti-anchoring · respetá morphScore>,
  "survivalProbability": <número entero 50-98>,
  "morphology": {
    "cytoplasm": "<descripción morfológica concisa: granularidad, vacuolas, inclusiones>",
    "perivitellineSpace": "<tamaño y presencia de gránulos>",
    "polarBody": "<integridad y morfología del PB1>",
    "zonaPellucida": "<grosor y uniformidad>",
    "anomalies": "<anomalías relevantes detectadas, o 'Sin anomalías destacables'>"
  },
  "notes": "<clinical observation in the OUTPUT LANGUAGE specified at the top · MUST mention at least 1 specific visual detail that differentiates THIS oocyte from a 'generic Medio Alto' oocyte>"
}

Analizá la imagen con criterios Istanbul Consensus 2024 y devolvé el JSON:`;

    // M#3 phase 2 · Claude + CNN en paralelo · Promise.allSettled NO aborta
    // si uno falla (Audit P1 fix 2026-05-14 · antes Promise.all hacía que un
    // 429 de Anthropic descarte el CNN result aunque haya respondido OK).
    // Latencia paralelo · max(Claude ~1.8s, CNN ~1.5s) ≈ ~1.8s vs serial 3.3s.
    const settled = await Promise.allSettled([
      client.messages.create({
        // Sonnet 4.5 · upgrade desde Haiku 4.5 · 2026-05-14. Razón: Haiku tenía
        // discriminación visual limitada para diferencias finas dentro de mismo
        // bucket morfológico (todos los ovocitos Medio Alto edad 38 daban 58/38).
        // Sonnet tiene 3x mejor visión · costo extra ~$2/mo a escala 250 análisis.
        // Si latency es problema (Sonnet 2-3s vs Haiku 1.5s), volver a Haiku · pero
        // perdemos la granularidad de scoring que el owner necesita para validación.
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1500,
        temperature: 1,
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

    // Unwrap allSettled · Claude SÍ es required (sin Claude no hay morfología
    // ni quality · no podemos devolver análisis útil) · CNN es opcional.
    const claudeSettled = settled[0];
    const cnnSettled = settled[1];
    if (claudeSettled.status === "rejected") {
      // Re-tirar para caer al catch existente y devolver 500 limpio. Cliente
      // ve "Analysis failed" y reintenta. CNN result si lo hubo se pierde · OK
      // porque mostrar CNN-only sin morfología/quality sería confuso.
      throw claudeSettled.reason;
    }
    const response = claudeSettled.value;
    // predictWithCNN ya devuelve null en error · pero si lanza por bug (no
    // debería) · allSettled lo captura · usamos null y log defensivo.
    const cnnResult = cnnSettled.status === "fulfilled" ? cnnSettled.value : null;
    if (cnnSettled.status === "rejected") {
      console.warn("[oocyte] CNN predict threw unexpectedly:", cnnSettled.reason?.message || cnnSettled.reason);
    }

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);

    // SEC-adversarial: si Claude marcó la imagen como no evaluable, respetar la decisión.
    // NO forzamos fallback a "Medio Alto" porque eso alucinaba análisis sobre imágenes basura
    // (logos, 1x1 pixels, capturas de pantalla, etc). Mejor devolver status explícito al cliente.
    if (parsed.status === "no_evaluable") {
      return res.status(200).json({
        status: "no_evaluable",
        rejectionReason: parsed.rejectionReason || (language === "en" ? "Image is not evaluable as an oocyte" : "La imagen no es evaluable como ovocito"),
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
        cytoplasm: parsed.morphology?.cytoplasm || (language === "en" ? "Normal" : "Normal"),
        perivitellineSpace: parsed.morphology?.perivitellineSpace || (language === "en" ? "Normal" : "Normal"),
        polarBody: parsed.morphology?.polarBody || (language === "en" ? "Intact" : "Íntegro"),
        zonaPellucida: parsed.morphology?.zonaPellucida || (language === "en" ? "Normal" : "Normal"),
        anomalies: parsed.morphology?.anomalies || (language === "en" ? "No notable anomalies" : "Sin anomalías destacables"),
      },
      notes: parsed.notes || "",
      // Diagnóstico · qué motor produjo la predicción. Útil para QA + post-mortem
      // accuracy tracking · Roadmap §6.1 + Track C calibration view. NO contiene
      // info sensible (sin imagen ni edad) · OK exponer al cliente.
      //
      // claudeRaw/cnnRaw expuestos por separado (escala 0-100) para que el cliente
      // los pueda persistir en Firestore y luego graficar Claude-only vs CNN-only
      // vs Combinado side-by-side. CNN viene del Cloud Run en escala 0-1 · acá
      // escalamos a 0-100 entero para consistencia con Claude.
      modelMeta: {
        cnnEnabled: isCNNEnabled(),
        cnnUsed: !!cnnResult,
        modelVersion: cnnResult?.modelVersion || "claude-only",
        cnnInferenceMs: cnnResult?.inferenceMs || null,
        claudeModel: "claude-sonnet-4-5-20250929",
        claudeRaw: {
          blasto: claudeBlasto,
          euploide: claudeEuploide,
        },
        // Sub-scores morfológicos de Claude (post-rewrite prompt 2026-05-14).
        // Útil para detectar bucketing oculto · si todos los ovocitos del
        // batch tienen mismo morphScore o muy similar, validación visual fallida.
        claudeScores: parsed.scores ? {
          citoplasma: typeof parsed.scores.citoplasma_score === "number" ? parsed.scores.citoplasma_score : null,
          pvs: typeof parsed.scores.pvs_score === "number" ? parsed.scores.pvs_score : null,
          pb1: typeof parsed.scores.pb1_score === "number" ? parsed.scores.pb1_score : null,
          zp: typeof parsed.scores.zp_score === "number" ? parsed.scores.zp_score : null,
          morphScore: typeof parsed.scores.morphScore === "number" ? parsed.scores.morphScore : null,
        } : null,
        cnnRaw: cnnResult ? {
          blasto: Math.round(cnnResult.blastoProb * 100),
          euploide: Math.round(cnnResult.euploideProb * 100),
        } : null,
        // Diagnóstico calibración 2026-05-14 · breakdown per-version-per-fold
        // del ensemble · permite comparar predicciones individuales con el
        // notebook · detecta divergencias preprocessing/ensemble math/loading.
        // Si AUC notebook 0.686 pero todos los outputs ~0.5 en producción ·
        // posible mala calibración del modelo (no bug nuestro).
        cnnDetail: cnnResult?.raw || null,
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
