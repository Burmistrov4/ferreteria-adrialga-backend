import { Router, Response, NextFunction } from 'express';
import {
  getUsuarios,
  createUsuario,
  updateUsuario,
  deleteUsuario,
} from '../controllers/usuarios.controllers';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();

// Todas las operaciones requieren sesión válida.
router.use(authenticateToken);

/** Solo ADMIN puede mutar usuarios (crear/editar/desactivar). */
const soloAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  const rol = (req.user?.rol ?? '').toString().toUpperCase();
  if (rol !== 'ADMIN') {
    return res
      .status(403)
      .json({ message: 'Solo un administrador puede gestionar usuarios' });
  }
  next();
};

// Lectura abierta a autenticados (los selects de cajero la necesitan).
router.get('/', getUsuarios);
router.post('/', soloAdmin, createUsuario);
router.put('/:id', soloAdmin, updateUsuario);
router.delete('/:id', soloAdmin, deleteUsuario);

export default router;
