import Anthropic from "@anthropic-ai/sdk";
import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { validateBase64, validateMimeType, ALLOWED_DOC_MIMES } from "../_lib/validation.js";
import { assertWithinRateLimit } from "../_lib/rateLimit.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONTEXT_PROMPTS = {
  hormonal: `Extrae valores de un perfil hormonal / reserva ovárica. Campos esperados:
- amh: hormona antimülleriana (ng/mL)
- afc: conteo folicular antral (número total ambos ovarios)
- fsh: FSH basal (mUI/mL)
- estradiol: estradiol basal (pg/mL)
- progBasal: progesterona basal (ng/mL)

Devolvé JSON exacto:
{
  "amh": <número|null>,
  "afc": <número|null>,
  "fsh": <número|null>,
  "estradiol": <número|null>,
  "progBasal": <número|null>,
  "notes": "<observaciones breves o cadena vacía>"
}`,

  control: `Extrae datos de un control ecográfico + laboratorio durante estimulación ovárica. Campos esperados:
- follicles.right / follicles.left: arrays de folículos por ovario con tamaño en mm. Ejemplo: [{"size": 12}, {"size": 14}]
- endometrium.thickness: mm
- endometrium.pattern: "Trilaminar" | "Homogéneo" | "Irregular"
- hormones.estradiol: pg/mL
- hormones.progesterone: ng/mL
- hormones.lh: mUI/mL

Devolvé JSON exacto:
{
  "follicles": { "right": [{"size": <número>}, ...], "left": [{"size": <número>}, ...] },
  "endometrium": { "thickness": <número|null>, "pattern": "Trilaminar|Homogéneo|Irregular|null" },
  "hormones": { "estradiol": <número|null>, "progesterone": <número|null>, "lh": <número|null> },
  "notes": "<observaciones>"
}`,

  trigger: `Extrae datos del trigger y de la punción folicular. Campos esperados:
- type: "hCG" | "Agonista" | "Dual"
- medication: ej "Ovidrel 250mcg" o "Decapeptyl 0.2mg"
- date: YYYY-MM-DD
- time: HH:MM (24h)
- total: número total de ovocitos recuperados
- mii: ovocitos maduros (MII)
- mi: ovocitos MI
- gv: ovocitos en vesícula germinal (GV)

Devolvé JSON exacto:
{
  "type": "hCG|Agonista|Dual|null",
  "medication": "<string o null>",
  "date": "<YYYY-MM-DD o ''>",
  "time": "<HH:MM o ''>",
  "total": <número|null>,
  "mii": <número|null>,
  "mi": <número|null>,
  "gv": <número|null>,
  "notes": "<observaciones>"
}`,
};

export default async function handler(req, res) {
  setCORS(req, res);
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!assertAllowedOrigin(req, res)) return;
  if (!(await assertWithinRateLimit(req, res))) return;

  try {
    const { base64, mimeType = "image/jpeg", context = "hormonal" } = req.body || {};

    // BACKEND-002 / BACKEND-005: validar payload + mime whitelist (imagen o PDF)
    if (!validateBase64(base64, res)) return;
    if (!validateMimeType(mimeType, ALLOWED_DOC_MIMES, res)) return;

    // BACKEND-022: mensaje genérico (antes filtraba los contextos válidos al atacante)
    if (!CONTEXT_PROMPTS[context]) return res.status(400).json({ error: "Invalid context" });

    const isDocument = mimeType === "application/pdf";

    const prompt = `Sos un sistema de extracción de datos médicos. Recibís una imagen o PDF de un estudio o informe y extraés valores numéricos con precisión.

${CONTEXT_PROMPTS[context]}

INSTRUCCIONES:
- Si un valor NO aparece claramente → usar null (no inventar).
- Para campos numéricos: extraé solo el número, sin unidades.
- Respondé ÚNICAMENTE con el JSON válido, sin markdown, sin texto extra.

Analizá el documento y devolvé el JSON:`;

    const contentBlock = isDocument
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [
        { role: "user", content: [contentBlock, { type: "text", text: prompt }] },
      ],
    });

    const raw = response.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    // BACKEND-024: si el parseo falla, es documento no evaluable (no es un 500 real).
    // Infra failures (timeout/5xx de Anthropic) sí caen al catch externo.
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn("clinical-ocr: respuesta no parseable, devolviendo no_evaluable", parseErr?.message);
      return res.status(200).json({
        status: "no_evaluable",
        rejectionReason: "No se pudo extraer datos del documento. Verificá la calidad, orientación y que el estudio corresponda al contexto seleccionado.",
        source: "claude",
        context,
      });
    }

    // Validación ligera por contexto
    const clean = sanitize(parsed, context);
    return res.status(200).json({ ...clean, status: "evaluable", source: "claude", context });
  } catch (err) {
    console.error("clinical-ocr error:", err);
    // BACKEND-006: no exponer err.message al cliente (information leak).
    // Los detalles quedan en console.error para Vercel logs.
    return res.status(500).json({ error: "OCR failed" });
  }
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitize(p, ctx) {
  if (ctx === "hormonal") {
    return {
      amh: num(p.amh),
      afc: num(p.afc),
      fsh: num(p.fsh),
      estradiol: num(p.estradiol),
      progBasal: num(p.progBasal),
      notes: String(p.notes || "").slice(0, 300),
    };
  }
  if (ctx === "control") {
    const fArr = (arr) => Array.isArray(arr) ? arr.map(f => ({ size: num(f?.size) })).filter(f => f.size != null) : [];
    const pat = ["Trilaminar", "Homogéneo", "Irregular"].includes(p?.endometrium?.pattern) ? p.endometrium.pattern : "";
    return {
      follicles: {
        right: fArr(p?.follicles?.right),
        left: fArr(p?.follicles?.left),
      },
      endometrium: {
        thickness: num(p?.endometrium?.thickness),
        pattern: pat,
      },
      hormones: {
        estradiol: num(p?.hormones?.estradiol),
        progesterone: num(p?.hormones?.progesterone),
        lh: num(p?.hormones?.lh),
      },
      notes: String(p.notes || "").slice(0, 300),
    };
  }
  if (ctx === "trigger") {
    const type = ["hCG", "Agonista", "Dual"].includes(p.type) ? p.type : "";
    return {
      type,
      medication: p.medication ? String(p.medication).slice(0, 60) : "",
      date: typeof p.date === "string" ? p.date.slice(0, 10) : "",
      time: typeof p.time === "string" ? p.time.slice(0, 5) : "",
      total: num(p.total),
      mii: num(p.mii),
      mi: num(p.mi),
      gv: num(p.gv),
      notes: String(p.notes || "").slice(0, 300),
    };
  }
  return p;
}
