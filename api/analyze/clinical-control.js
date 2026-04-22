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
    const {
      day = 0,
      follicles = { right: [], left: [] },
      endometrium = {},
      hormones = {},
      protocolContext = null, // { type, fshDose } opcional
    } = req.body || {};

    const right = Array.isArray(follicles?.right) ? follicles.right : [];
    const left = Array.isArray(follicles?.left) ? follicles.left : [];
    const all = [...right, ...left].map(f => Number(f?.size) || 0);

    const maxFollicle = all.length ? Math.max(...all) : 0;
    const over14 = all.filter(s => s >= 14).length;
    const over17 = all.filter(s => s >= 17).length;

    const e2 = Number(hormones?.estradiol) || null;
    const p4 = Number(hormones?.progesterone) || null;
    const lh = Number(hormones?.lh) || null;
    const endoT = Number(endometrium?.thickness) || null;
    const endoP = endometrium?.pattern || "";

    const prompt = `Sos un sistema de IA especializado en medicina reproductiva. Tu rol es interpretar el control ecográfico + hormonal de una paciente en estimulación ovárica y sugerir la conducta a seguir (continuar / ajustar dosis / trigger / cancelar / freeze-all).

REFERENCIAS:
- ESHRE Ovarian Stimulation Guideline 2019
- ASRM SHO prevention and management 2020
- Criterios de trigger óptimo: ≥2-3 folículos ≥17mm, endometrio ≥7mm trilaminar

DATOS DEL CONTROL:
- Día del ciclo de estimulación: ${day}
- Folículos ovario derecho (mm): ${JSON.stringify(right.map(f => f?.size).filter(x => x))}
- Folículos ovario izquierdo (mm): ${JSON.stringify(left.map(f => f?.size).filter(x => x))}
- Folículo líder: ${maxFollicle} mm
- Folículos ≥14mm: ${over14}
- Folículos ≥17mm: ${over17}
- Endometrio: ${endoT != null ? endoT + " mm" : "no registrado"} ${endoP || ""}
- Estradiol: ${e2 != null ? e2 + " pg/mL" : "no registrado"}
- Progesterona: ${p4 != null ? p4 + " ng/mL" : "no registrado"}
- LH: ${lh != null ? lh + " mUI/mL" : "no registrado"}
${protocolContext ? `- Protocolo: ${protocolContext.type}${protocolContext.fshDose ? ", FSH " + protocolContext.fshDose + " UI" : ""}` : ""}

CRITERIOS DE DECISIÓN:
1. Trigger maduro: ≥2 folículos ≥17mm + folículo líder ≥18mm + endometrio ≥7mm.
2. Si E2 > 3000 o >15 folículos totales → trigger agonista (Decapeptyl 0.2mg) para prevenir SHO, considerar freeze-all.
3. Progesterona > 1.5 ng/mL previo al trigger → considerar freeze-all (altera receptividad endometrial).
4. Folículo líder 14-17mm → continuar misma dosis, control en 1-2 días.
5. Folículo líder < 14mm en día ≥7 → evaluar respuesta baja, considerar aumentar FSH.
6. LH > 10 con antagonista no cubierto → agregar antagonista urgente.
7. Endometrio < 7mm cerca del trigger → evaluar soporte estrogénico o freeze-all.

INSTRUCCIÓN CRÍTICA: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown.

Estructura exacta requerida:
{
  "action": "continue|adjust_dose|trigger|cancel|freeze_all",
  "readyForTrigger": <boolean>,
  "suggestedTrigger": "<ej 'hCG Ovidrel 250mcg' o 'Agonista GnRH Decapeptyl 0.2mg' o null si no corresponde>",
  "nextControlDays": <número de días hasta próximo control, 0 si trigger ya>,
  "summary": "<texto clínico en español, 2-4 oraciones, citando hallazgos concretos (mm del líder, conteo de ≥14/≥17, E2/P4 si relevantes) y la conducta sugerida>",
  "alerts": ["<alerta 1>", "<alerta 2>"]
}

Devolvé el JSON:`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);

    const VALID_ACTIONS = ["continue", "adjust_dose", "trigger", "cancel", "freeze_all"];

    const result = {
      action: VALID_ACTIONS.includes(parsed.action) ? parsed.action : "continue",
      readyForTrigger: Boolean(parsed.readyForTrigger),
      suggestedTrigger: parsed.suggestedTrigger ? String(parsed.suggestedTrigger).slice(0, 100) : null,
      nextControlDays: Number.isFinite(Number(parsed.nextControlDays)) ? Math.max(0, Math.min(7, Number(parsed.nextControlDays))) : 2,
      summary: String(parsed.summary || "").slice(0, 800),
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts.slice(0, 6).map(a => String(a).slice(0, 200)) : [],
      source: "claude",
    };

    return res.status(200).json(result);
  } catch (err) {
    // BACKEND-012: logSafeError — no filtrar req.body / err.cause en Vercel logs.
    logSafeError("analyze/clinical-control", err);
    // BACKEND-006: no exponer err.message al cliente (information leak).
    // Los detalles quedan en console.error para Vercel logs.
    return res.status(500).json({ error: "Analysis failed" });
  }
}
