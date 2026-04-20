// Origin allowlist para proteger la API key de Anthropic.
// Rechaza requests que no vengan de nuestros dominios (Vercel prod, previews, localhost dev).
//
// Limitación: un atacante con curl puede spoofear el header Origin. Esto cubre
// bots, scanners y sitios de terceros, pero NO es defensa contra atacantes
// determinados. Para eso necesitamos rate limiting (próxima iteración).

// Dominios de producción fijos (aliases estables de Vercel).
const PROD_ALLOWED = new Set([
  "https://clinicalq.vercel.app",
  "https://ferti-landing.vercel.app",
  "https://oocyte-app.vercel.app",
  "https://blastocyst-app.vercel.app",
  "https://nico-tala9-spermai-app.vercel.app",
  // Dominios custom futuros (ej clinicalq.ferti.ai) agregar acá.
]);

// Previews de Vercel dentro del team "nicotala9s-projects".
// Pattern: <nombre>-<hash>-nicotala9s-projects.vercel.app
//          <nombre>-git-<branch>-nicotala9s-projects.vercel.app
const PREVIEW_REGEX = /^https:\/\/[a-z0-9-]+-nicotala9s-projects\.vercel\.app$/;

// Dev local (Vite, Next dev, etc).
const LOCAL_REGEX = /^http:\/\/localhost(:\d+)?$/;

export function isOriginAllowed(origin) {
  if (!origin || typeof origin !== "string") return false;
  const clean = origin.replace(/\/$/, "");
  if (PROD_ALLOWED.has(clean)) return true;
  if (PREVIEW_REGEX.test(clean)) return true;
  if (LOCAL_REGEX.test(clean)) return true;
  return false;
}

// Llamá esto al inicio del handler. Si retorna false, el handler ya envió 403
// y debe abortar (return inmediato).
export function assertAllowedOrigin(req, res) {
  // OPTIONS (preflight) ya se maneja por vercel.json CORS — no llegamos acá.
  const origin = (req.headers?.origin || "").trim();
  if (!isOriginAllowed(origin)) {
    console.warn("[auth] rejected origin:", origin || "(none)", "path:", req.url);
    res.status(403).json({ error: "Forbidden", detail: "Origin not allowed" });
    return false;
  }
  return true;
}
