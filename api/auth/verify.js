// GET /api/auth/verify
// header: Authorization: Bearer <token>
// 200: { user: <payload>, expiresAt: ISO }
// 401: { error: "Invalid token" }
//
// Usado por el cliente al boot de la app para decidir si el token guardado en
// localStorage sigue sirviendo o hay que mandar al login screen.

import { assertAllowedOrigin } from "../_lib/auth.js";
import { setCORS, handleOptions } from "../_lib/cors.js";
import { verifySession, bearerFromReq } from "../_lib/jwt.js";

export default async function handler(req, res) {
  setCORS(req, res, { methods: "GET, POST, OPTIONS" });
  if (handleOptions(req, res)) return;

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!assertAllowedOrigin(req, res)) return;

  const token = bearerFromReq(req);
  if (!token) return res.status(401).json({ error: "Missing token" });

  const payload = verifySession(token);
  if (!payload) return res.status(401).json({ error: "Invalid or expired token" });

  const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  return res.status(200).json({ user: payload, expiresAt });
}
