import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: any;
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Acceso denegado: Token no proporcionado' });
  }

  // Fail-closed: si por algún motivo JWT_SECRET no está configurado, ningún
  // token es válido (nunca se asume una clave por defecto forjable). El
  // arranque de index.ts ya aborta si falta, pero el middleware se defiende
  // también por si se invoca fuera del flujo habitual.
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ code: 'AUTH_NO_CONFIGURADO', message: 'Auth no configurada' });
  }

  jwt.verify(token, jwtSecret, (err, user: any) => {
    if (err) {
      // 401 + código explícito: el frontend intercepta TOKEN_EXPIRADO para
      // guardar el carrito y redirigir al login con mensaje (no 403 ambiguo).
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          code: 'TOKEN_EXPIRADO',
          message: 'Tu sesión ha expirado. Inicia sesión nuevamente.',
        });
      }
      return res.status(401).json({
        code: 'TOKEN_INVALIDO',
        message: 'Token inválido',
      });
    }
    // Normalización del payload: el JWT se emite con el claim `Usuario_ID`
    // (ver auth.controllers.ts). Aceptamos alias por compatibilidad, pero el
    // shape canónico que consumen los controladores es `usuarioId`.
    req.user = {
      usuarioId: user.Usuario_ID ?? user.usuarioId ?? user.id,
      nombre: user.Nombre ?? user.nombre,
      rol: user.Rol ?? user.rol,
    };
    next();
  });
};