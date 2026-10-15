import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { hashPassword } from '../utils/password.util';
import { responderErrorPrisma } from '../utils/errores';
import { AuthRequest } from '../middlewares/auth.middleware';
import { IoStore } from '../utils/socket';

const ROLES = ['CAJERO', 'SUPERVISOR', 'ADMIN'] as const;
type Rol = (typeof ROLES)[number];

/**
 * El usuario RAÍZ es intocable: credencial `admin` (case-insensitive) o
 * Usuario_ID = 1. No puede eliminarse, desactivarse, cambiar de rol ni de
 * credencial. Regla inquebrantable del sistema.
 */
const esRoot = (u: { Usuario_ID: number; Credencial: string }) =>
  u.Usuario_ID === 1 || u.Credencial.toLowerCase() === 'admin';

/** Serializa un usuario SIN exponer nunca el hash de la contraseña. */
const sanitizar = (u: any) => ({
  Usuario_ID: u.Usuario_ID,
  Nombre: u.Nombre,
  Credencial: u.Credencial,
  Rol: u.Rol,
  Activo: u.Activo,
  Fecha_Registro: u.Fecha_Registro,
  TienePIN: Boolean(u.PIN_Operaciones),
});

/** GET /api/usuarios — lista para el panel y para selects de cajero. */
export const getUsuarios = async (_req: Request, res: Response) => {
  try {
    const usuarios = await prisma.usuarios.findMany({
      orderBy: { Usuario_ID: 'asc' },
    });
    return res.json(usuarios.map(sanitizar));
  } catch (error) {
    return responderErrorPrisma(res, error, { recurso: 'usuario', contexto: 'obtener los' });
  }
};

/** POST /api/usuarios — crea un colaborador (contraseña hasheada con bcrypt). */
export const createUsuario = async (req: Request, res: Response) => {
  try {
    const nombre = (req.body.Nombre ?? '').toString().trim();
    const credencial = (req.body.Credencial ?? '').toString().trim();
    const password = (req.body.Password ?? '').toString();
    const rol = (req.body.Rol ?? 'CAJERO').toString().toUpperCase() as Rol;
    const pin = (req.body.PinOperaciones ?? '').toString().trim();

    if (!nombre || !credencial || password.length < 4) {
      return res.status(400).json({
        message: 'Nombre, credencial y contraseña (mínimo 4 caracteres) son obligatorios',
      });
    }
    if (!ROLES.includes(rol)) {
      return res.status(400).json({ message: `Rol inválido. Use: ${ROLES.join(', ')}` });
    }

    const nuevo = await prisma.usuarios.create({
      data: {
        Nombre: nombre,
        Credencial: credencial,
        Password: await hashPassword(password),
        Rol: rol,
        Activo: req.body.Activo ?? true,
        PIN_Operaciones: pin ? await hashPassword(pin) : null,
      },
    });
    IoStore.emitDbUpdate('usuarios', `Usuario creado: ${nuevo.Nombre}`, { usuarioId: nuevo.Usuario_ID });
    return res.status(201).json({ message: 'Usuario creado', usuario: sanitizar(nuevo) });
  } catch (error) {
    // P2002 (Credencial duplicada) → 409 vía responderErrorPrisma.
    return responderErrorPrisma(res, error, { recurso: 'usuario', contexto: 'crear el' });
  }
};

/** PUT /api/usuarios/:id — edición con protección del usuario raíz. */
export const updateUsuario = async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const actual = await prisma.usuarios.findUnique({ where: { Usuario_ID: id } });
    if (!actual) return res.status(404).json({ message: 'Usuario no encontrado' });

    const root = esRoot(actual);
    const rolNuevo =
      req.body.Rol != null ? String(req.body.Rol).toUpperCase() : undefined;
    const activoNuevo =
      req.body.Activo != null ? Boolean(req.body.Activo) : undefined;
    const credNueva =
      req.body.Credencial != null ? String(req.body.Credencial).trim() : undefined;

    // ── PROTECCIÓN ROOT (403) ──────────────────────────────────────────────
    if (root) {
      if (rolNuevo && rolNuevo !== actual.Rol) {
        return res.status(403).json({
          message: 'El usuario administrador raíz no puede cambiar de rol',
        });
      }
      if (activoNuevo === false) {
        return res.status(403).json({
          message: 'El usuario administrador raíz no puede desactivarse',
        });
      }
      if (credNueva && credNueva.toLowerCase() !== actual.Credencial.toLowerCase()) {
        return res.status(403).json({
          message: 'La credencial del administrador raíz no puede modificarse',
        });
      }
    }
    if (rolNuevo && !ROLES.includes(rolNuevo as Rol)) {
      return res.status(400).json({ message: `Rol inválido. Use: ${ROLES.join(', ')}` });
    }

    const data: any = {};
    if (req.body.Nombre != null) data.Nombre = String(req.body.Nombre).trim();
    if (!root && credNueva) data.Credencial = credNueva;
    if (rolNuevo) data.Rol = rolNuevo;
    if (activoNuevo != null) data.Activo = activoNuevo;
    if (req.body.Password) data.Password = await hashPassword(String(req.body.Password));
    if (req.body.PinOperaciones != null) {
      const pin = String(req.body.PinOperaciones).trim();
      data.PIN_Operaciones = pin ? await hashPassword(pin) : null;
    }

    const actualizado = await prisma.usuarios.update({ where: { Usuario_ID: id }, data });
    IoStore.emitDbUpdate('usuarios', `Usuario actualizado: ${actualizado.Nombre}`, { usuarioId: actualizado.Usuario_ID });
    return res.json({ message: 'Usuario actualizado', usuario: sanitizar(actualizado) });
  } catch (error) {
    return responderErrorPrisma(res, error, { recurso: 'usuario', contexto: 'actualizar el' });
  }
};

/**
 * DELETE /api/usuarios/:id — SOFT DELETE (Activo = false).
 * No se hace DELETE duro para preservar la integridad referencial de las
 * facturas/notas históricas (trazabilidad "quién facturó qué").
 */
export const deleteUsuario = async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const actual = await prisma.usuarios.findUnique({ where: { Usuario_ID: id } });
    if (!actual) return res.status(404).json({ message: 'Usuario no encontrado' });

    if (esRoot(actual)) {
      return res.status(403).json({
        message: 'El usuario administrador raíz no puede eliminarse',
      });
    }
    if (Number(req.user?.usuarioId) === id) {
      return res.status(403).json({
        message: 'No puedes desactivar tu propio usuario',
      });
    }

    const desactivado = await prisma.usuarios.update({
      where: { Usuario_ID: id },
      data: { Activo: false },
    });
    IoStore.emitDbUpdate('usuarios', `Usuario desactivado: ${desactivado.Nombre}`, { usuarioId: desactivado.Usuario_ID });
    return res.json({
      message: 'Usuario desactivado (soft delete)',
      usuario: sanitizar(desactivado),
    });
  } catch (error) {
    return responderErrorPrisma(res, error, { recurso: 'usuario', contexto: 'desactivar el' });
  }
};
