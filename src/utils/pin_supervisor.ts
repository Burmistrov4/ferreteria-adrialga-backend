// adrialga-backend/src/utils/pin_supervisor.ts
// ─────────────────────────────────────────────────────────────────────────────
// Validador central del PIN de operaciones de SUPERVISOR/ADMIN.
//
// Mandato FRENTE 2: el PIN NUNCA se almacena ni se compara en texto plano.
// Se persiste como hash bcrypt y la verificación recorre los candidatos con
// bcrypt.compare (comparación en tiempo constante por diseño de bcrypt).
// Un único punto de verdad usado por:
//   · POST /auth/validar-pin-supervisor (autorización en caliente de UI)
//   · POST /facturas/:id/reversar (autorización server-side de la reversión)
// ─────────────────────────────────────────────────────────────────────────────
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';

export interface SupervisorAutorizado {
  Usuario_ID: number;
  Nombre: string;
  Rol: string;
}

/**
 * Valida un PIN de operaciones contra los usuarios SUPERVISOR/ADMIN activos.
 *
 * Estrategia: los hashes viven en la BD (uno por usuario autorizante); el PIN
 * recibido se compara con bcrypt contra cada hash. Nunca se filtra por el PIN
 * en el WHERE (eso sería comparación de texto plano y filtraría por patrón).
 *
 * @returns el supervisor autorizante, o null si el PIN no coincide con nadie.
 */
export async function validarPinSupervisorHash(
  tx: Prisma.TransactionClient | PrismaClient,
  pin: string
): Promise<SupervisorAutorizado | null> {
  const pinLimpio = (pin ?? '').toString().trim();
  if (!pinLimpio) return null;

  // Candidatos activos con hash de PIN registrado.
  const candidatos = await tx.usuarios.findMany({
    where: {
      Rol: { in: ['SUPERVISOR', 'ADMIN'] },
      Activo: true,
      PIN_Operaciones: { not: null }
    },
    select: { Usuario_ID: true, Nombre: true, Rol: true, PIN_Operaciones: true }
  });

  for (const c of candidatos) {
    const hash = c.PIN_Operaciones;
    if (!hash) continue;
    // Un valor heredado sin formato bcrypt (prefijo $2) no puede validarse
    // de forma segura: se ignora y se registra para migración del seed.
    if (!hash.startsWith('$2')) continue;
    const coincide = await bcrypt.compare(pinLimpio, hash);
    if (coincide) {
      return { Usuario_ID: c.Usuario_ID, Nombre: c.Nombre, Rol: c.Rol };
    }
  }
  return null;
}
