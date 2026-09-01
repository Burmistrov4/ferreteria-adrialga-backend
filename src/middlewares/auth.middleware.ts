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

  jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, user: any) => {
    if (err) {
      return res.status(403).json({ message: 'Token inválido o expirado' });
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