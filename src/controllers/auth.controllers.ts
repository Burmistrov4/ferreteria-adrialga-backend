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