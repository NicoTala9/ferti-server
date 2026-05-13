// Resend client wrapper · Fase J.1.b
//
// Decisión §5.1 owner Set B: Resend (free tier 100 emails/día).
//
// Feature flag `RECOVERY_ENABLED` env var · default false. Owner activa cuando
// la cuenta Resend + DNS records (SPF/DKIM/DMARC) están listos pre-deploy.
//
// Sin RECOVERY_ENABLED=true, sendRecoveryEmail() es no-op (logea y retorna
// `{ delivered: false, reason: "feature-disabled" }`).
//
// Migración futura: cuando se quiera tenant-aware `from: noreply@{tenant-domain}`
// con custom domains, refactor a Cloud Function trigger que lea
// `platformClinics/{cid}.brandingEmail` y use ese from.

const RESEND_API_URL = "https://api.resend.com/emails";

function isEnabled() {
  return process.env.RECOVERY_ENABLED === "true";
}

function getApiKey() {
  return process.env.RESEND_API_KEY || "";
}

function getFrom() {
  return process.env.RESEND_FROM || "noreply@fertiq.com";
}

/**
 * Envía un email vía Resend.
 *
 * @param {object} args
 * @param {string} args.to
 * @param {string} args.subject
 * @param {string} args.html
 * @returns {Promise<{ delivered: boolean, id?: string, reason?: string }>}
 */
export async function sendEmail({ to, subject, html }) {
  if (!isEnabled()) {
    console.warn("[resend] RECOVERY_ENABLED=false · email no enviado a", to);
    return { delivered: false, reason: "feature-disabled" };
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("[resend] RESEND_API_KEY missing · email no enviado a", to);
    return { delivered: false, reason: "missing-api-key" };
  }
  try {
    const resp = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: getFrom(),
        to: [to],
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.error("[resend] error response:", resp.status, errBody);
      return { delivered: false, reason: `http-${resp.status}` };
    }
    const data = await resp.json();
    return { delivered: true, id: data?.id };
  } catch (e) {
    console.error("[resend] network error:", e?.message);
    return { delivered: false, reason: "network-error" };
  }
}
