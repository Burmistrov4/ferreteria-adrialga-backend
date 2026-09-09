import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { comparePassword } from '../utils/password.util';

export const login = async (req: Request, res: Response) => {
  const { Credencial, Password } = req.body;

  try {
    const usuario = await prisma.usuarios.findUnique({ where: { Credencial } });

    if (!usuario || !usuario.Activo) {
      return res.status(401).json({ message: 'Credenciales inválidas o usuario inactivo' });
    }

    const validPassword = await comparePassword(Password, usuario.Password);
    if (!validPassword) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { Usuario_ID: usuario.Usuario_ID, Nombre: usuario.Nombre, Rol: usuario.Rol },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '12h' }
    );

    return res.json({
      token,
      usuario: {
        id: usuario.Usuario_ID,
        nombre: usuario.Nombre,
        rol: usuario.Rol
      }
    });
  } catch (error) {
    return res.status(500).json({ message: 'Error interno en el servidor', error });
  }
};

/**
 * POST /auth/validar-pin-supervisor
 * Valida el PIN de operación de un perfil SUPERVISOR/ADMIN para autorizar en
 * caliente una acción crítica (reversión de ventas, ajustes de inventario).
 * Body: { pin: string }. Retorna el usuario autorizante para persistirlo.
 */
export const validarPinSupervisor = async (req: Request, res: Response) => {
  const pin = (req.body?.pin ?? '').toString().trim();
  if (!pin) {
    return res.status(400).json({ valido: false, error: 'PIN de Supervisor requerido' });
  }

  try {
    const supervisor = await prisma.usuarios.findFirst({
      where: {
        PIN_Operaciones: pin,
        Rol: { in: ['SUPERVISOR', 'ADMIN'] },
        Activo: true
      },
      select: { Usuario_ID: true, Nombre: true, Rol: true }
    });

    if (!supervisor) {
      return res.status(401).json({ valido: false, error: 'PIN de Supervisor inválido' });
    }

    return res.json({
      valido: true,
      usuarioId: supervisor.Usuario_ID,
      nombre: supervisor.Nombre,
      rol: supervisor.Rol
    });
  } catch (error) {
    return res.status(500).json({ message: 'Error interno en el servidor', error });
  }
};