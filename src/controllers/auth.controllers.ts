import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { comparePassword } from '../utils/password.util';
import { validarPinSupervisorHash } from '../utils/pin_supervisor';

export const login = async (req: Request, res: Response) => {
  const { Credencial, Password } = req.body ?? {};

  // ── Validación de entrada (fail-fast antes de tocar la BD) ───────────────
  // Un cuerpo vacío o con campos ausentes hacía que Prisma recibiera
  // `Credencial: undefined` y lanzara una excepción que se traducía en 500.
  // Ahora se responde 400 con un mensaje genérico (sin revelar la causa).
  if (
    typeof Credencial !== 'string' ||
    typeof Password !== 'string' ||
    Credencial.trim() === '' ||
    Password === ''
  ) {
    return res.status(400).json({ message: 'Credencial y contraseña son requeridos' });
  }

  try {
    const usuario = await prisma.usuarios.findUnique({ where: { Credencial } });

    if (!usuario || !usuario.Activo) {
      return res.status(401).json({ message: 'Credenciales inválidas o usuario inactivo' });
    }

    const validPassword = await comparePassword(Password, usuario.Password);
    if (!validPassword) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    // HALLAZGO DE AUDITORÍA (2026-10-14): antes había un `|| 'fallback_secret'`
    // que permitía firmar/verificar tokens con una clave pública conocida si la
    // variable faltaba. index.ts aborta el arranque sin JWT_SECRET; aquí se
    // refuerza (defensa en profundidad) para que ningún import aislado use el
    // fallback. Sin clave → error interno, nunca un token forjable.
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error('[auth] FATAL: JWT_SECRET ausente al firmar el token de sesión.');
      return res.status(500).json({ message: 'Error interno en el servidor' });
    }

    const token = jwt.sign(
      { Usuario_ID: usuario.Usuario_ID, Nombre: usuario.Nombre, Rol: usuario.Rol },
      jwtSecret,
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
    // SEGURIDAD: en autenticacion NUNCA se devuelve el objeto `error` crudo
    // (puede contener SQL, rutas del servidor o el stack). Se registra en el
    // log y se responde un mensaje generico e indistinguible.
    console.error('[auth] Error en login:', error);
    return res.status(500).json({ message: 'Error interno en el servidor' });
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
    // El PIN se verifica con bcrypt contra los hashes de los supervisores
    // activos: nunca se compara en texto plano (FRENTE 2, auditoría de PIN).
    const supervisor = await validarPinSupervisorHash(prisma, pin);

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
    // SEGURIDAD: en autenticacion NUNCA se devuelve el objeto `error` crudo
    // (puede contener SQL, rutas del servidor o el stack). Se registra en el
    // log y se responde un mensaje generico e indistinguible.
    console.error('[auth] Error en login:', error);
    return res.status(500).json({ message: 'Error interno en el servidor' });
  }
};