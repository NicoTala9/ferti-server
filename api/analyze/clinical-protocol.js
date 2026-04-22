import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";
import { logSafeError } from "../_lib/logSafe.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  setCORS(req, res);
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!assertAllowedOrigin(req, res)) return;
  if (!(await assertWithinRateLimit(req, res))) return;

  try {
    // BACKEND-016: `clinicStats` se acepta en el body para backward-compat pero
    // NO se reinyecta en el prompt a Anthropic. Evitamos filtrar tasas de embarazo,
    // promedios de MII y protocolos más usados (métricas operativas sensibles de
    // la clínica) a un proveedor externo. Ver docs/AUDIT/00-SUMMARY.md → BACKEND-016.
    const {
      age,
      amh = null,
      afc = null,
      bmi = null,
      diagnosis = "",
      previousCycles = 0,
    } = req.body || {};

    if (age == null || Number.isNaN(Number(age))) {
      return res.status(400).json({ error: "Missing/invalid 'age'" });
    }

    const ageGroup =
      age < 30 ? "<30" :
      age <= 34 ? "30-34" :
      age <= 37 ? "35-37" :
      age <= 40 ? "38-40" :
      age <= 42 ? "41-42" : ">42";

    // Sin clinicContext: prompt anclado sólo a referencias bibliográficas + datos de la paciente de este request.
    const clinicContext = "";

    const prompt = `Sos un sistema de IA especializado en medicina reproductiva. Tu rol es asistir al médico en la PLANIFICACIÓN de un protocolo de estimulación ovárica controlada (FIV/ICSI). No reemplazás al médico: tu salida es una SUGERENCIA razonada.

REFERENCIAS CLÍNICAS:
- ESHRE 2019 — Ovarian Stimulation for IVF/ICSI (guideline)
- Poseidón Group 2016 — clasificación de baja respuesta
- Bologna Criteria 2011 — poor responders
- ASRM 2020 — manejo de PCOS/SHO
- SART 2023 — tasas por edad

DATOS DE LA PACIENTE:
- Edad: ${age} años (grupo etario: ${ageGroup})
- AMH: ${amh != null ? amh + " ng/mL" : "no disponible"}
- AFC: ${afc != null ? afc : "no disponible"}
- BMI: ${bmi != null ? bmi : "no disponible"}
- Diagnóstico: ${diagnosis || "no especificado"}
- Ciclos previos de estimulación: ${previousCycles}
${clinicContext}

CRITERIOS CLÍNICOS A APLICAR:
1. Reserva ovárica:
   - Baja: AMH < 1.2 ng/mL o AFC < 5
   - Normal: AMH 1.2–3.5 y AFC 5–20
   - Alta: AMH > 3.5 o AFC > 20 (riesgo SHO)

2. Clasificación Poseidón:
   - Grupo 1: <35 años, reserva normal, baja respuesta inesperada
   - Grupo 2: ≥35 años, reserva normal, baja respuesta inesperada
   - Grupo 3: <35 años, baja reserva esperada
   - Grupo 4: ≥35 años, baja reserva esperada

3. Selección de protocolo:
   - Antagonista estándar: primera elección en la mayoría (más corto, menor riesgo de SHO)
   - Agonista largo: considerar en endometriosis severa, baja reserva con respuesta errática previa
   - Mini-FIV / estímulo suave: Poseidón 4, fallos reiterados, pacientes mayores con muy baja reserva
   - PPOS: candidata a freeze-all, SOP con riesgo SHO alto
   - DuoStim: Poseidón 3-4, urgencia oncológica, acumulación de ovocitos

4. Dosificación FSH aproximada:
   - Alta reserva / SOP: 100–150 UI
   - Reserva normal <35a: 150–225 UI
   - Reserva normal 35–37a: 200–250 UI
   - Baja reserva <40a: 225–300 UI + LH
   - ≥40a con baja reserva: 150–225 UI (mini-FIV) o 300 UI (agresivo si se busca acumular)

5. Alertas obligatorias:
   - AMH > 3.5 o AFC > 20: advertir SHO + considerar trigger agonista
   - BMI > 30: advertir respuesta y absorción alteradas
   - Endometriosis: advertir reserva funcional menor a la estimada
   - Edad ≥ 40 con baja reserva: advertir baja respuesta y acumulación de ovocitos

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones fuera del JSON.

Estructura exacta requerida:
{
  "type": "Antagonista|Agonista largo|Mini-FIV|PPOS|DuoStim",
  "expectedOocytes": "<rango en formato 'N-M', ej '6-10'>",
  "medications": [
    { "name": "Gonal-F|Puregon|Menopur|Pergoveris|Luveris|Cetrotide|Orgalutran|...",
      "dose": <número>, "unit": "UI|mg|mcg",
      "frequency": "diaria|cada 12h|...",
      "startDay": <número, día del ciclo> }
  ],
  "aiReasoning": "<razonamiento clínico en español, 2-4 oraciones, citando Poseidón/ESHRE donde aplique>",
  "alerts": ["<alerta clínica 1>", "<alerta clínica 2>", ...]
}

Las medicaciones deben incluir: el gonadotrófico principal (FSH ± LH), el antagonista/agonista si corresponde, y cualquier suplemento indicado (ej LH en baja reserva). No incluyas el trigger (eso se decide al momento).

Devolvé el JSON:`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);

    const VALID_TYPES = ["Antagonista", "Agonista largo", "Mini-FIV", "PPOS", "DuoStim"];
    const meds = Array.isArray(parsed.medications) ? parsed.medications : [];

    const result = {
      type: VALID_TYPES.includes(parsed.type) ? parsed.type : "Antagonista",
      expectedOocytes: typeof parsed.expectedOocytes === "string" ? parsed.expectedOocytes : "",
      medications: meds.slice(0, 6).map(m => ({
        name: String(m?.name || "").slice(0, 40),
        dose: Number(m?.dose) || 0,
        unit: ["UI", "mg", "mcg"].includes(m?.unit) ? m.unit : "UI",
        frequency: String(m?.frequency || "diaria").slice(0, 30),
        startDay: Number(m?.startDay) || 1,
      })).filter(m => m.name),
      aiReasoning: String(parsed.aiReasoning || "").slice(0, 800),
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts.slice(0, 8).map(a => String(a).slice(0, 200)) : [],
      aiSuggested: true,
      source: "claude",
    };

    return res.status(200).json(result);
  } catch (err) {
    // BACKEND-012: logSafeError — no filtrar req.body / err.cause en Vercel logs.
    logSafeError("analyze/clinical-protocol", err);
    // BACKEND-006: no exponer err.message al cliente (information leak).
    // Los detalles quedan en console.error para Vercel logs.
    return res.status(500).json({ error: "Analysis failed" });
  }
}
