import rateLimit from 'express-rate-limit';

/**
 * Limiter ESTRICTO para operaciones sensibles que, forzadas por fuerza bruta,
 * permiten escalar privilegios o revertir ventas:
 *   - POST /api/auth/validar-pin-supervisor (PIN de 4-6 dígitos)
 *   - POST /api/facturas/:id/reversar (exige PIN de supervisor)
 *
 * Se limita por IP + usuario autenticado: un atacante no puede bloquear a los
 * demás usuarios de una LAN que comparte IP, y tampoco puede reintentar el PIN
 * indefinidamente desde una sola sesión. Debe montarse DESPUÉS de
 * `authenticateToken` para que `req.user` esté disponible.
 */
export const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => `${req.ip}:${req.user?.usuarioId ?? 'anon'}`,
  message: { error: 'Demasiados intentos. Espera 15 minutos antes de reintentar.' },
});
