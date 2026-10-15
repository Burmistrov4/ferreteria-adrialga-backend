// src/utils/errores.ts
// Mapeo UNIFORME de errores de Prisma a respuestas HTTP accionables.
//
// Problema que resuelve: cada controlador repetía (o directamente omitía) el
// mapeo de códigos Prisma, devolviendo 500 genéricos incluso ante errores
// previsibles (duplicado, FK inválida, registro inexistente). El cajero veía
// "Error interno del servidor" en vez de "Ya existe un RIF con ese valor".
//
// Contrato de salida (estable para el frontend):
//   { success: false, code: 'DUPLICADO' | 'NULO_INVALIDO' | 'FK_INVALIDA'
//                          | 'NO_ENCONTRADO' | 'ERROR_INTERNO',
//     message: string, campo?: string }
//
// Nunca se filtra el stack ni la consulta SQL cruda al cliente: solo el
// resumen legible. El detalle técnico queda en el log del servidor.
import { Response } from 'express';

export type CodigoError =
  | 'DUPLICADO'
  | 'NULO_INVALIDO'
  | 'FK_INVALIDA'
  | 'NO_ENCONTRADO'
  | 'ERROR_INTERNO';

export interface RespuestaError {
  success: false;
  code: CodigoError;
  message: string;
  campo?: string;
  /**
   * Alias retrocompatible: los controladores antiguos respondian
   * `{ error: string }` y partes del frontend ya leen esa clave. Se mantiene
   * para no romper clientes existentes mientras se migra al contrato nuevo.
   */
  error?: string;
}

/** Extrae el nombre del campo/índice implicado en una violación P2002. */
function campoDeMeta(meta: any): string {
  const target = meta?.target;
  const partes = Array.isArray(target) ? target : [target];
  return partes.filter(Boolean).join(', ');
}

/**
 * Traduce un error de Prisma a (status, payload) y responde.
 *
 * @param res      Response de Express.
 * @param error    Error capturado (se tipa como unknown a propósito).
 * @param recurso  Sustantivo del recurso ("categoría", "cliente", ...) usado en
 *                 el texto del mensaje.
 * @param contexto Acción en curso para el log ("registrar", "actualizar"...).
 *
 * Devuelve el `Response` para poder usar `return responderErrorPrisma(...)`.
 */
export function responderErrorPrisma(
  res: Response,
  error: unknown,
  {
    recurso = 'registro',
    contexto = 'procesar',
  }: { recurso?: string; contexto?: string } = {},
): Response {
  const err = error as any;
  const code: string | undefined = err?.code;

  // Siempre se registra en el servidor con el detalle real.
  console.error(`[${contexto}] Error Prisma ${code ?? '(sin código)'}:`, err);

  // Envio centralizado: garantiza que `error` (alias legacy) acompane siempre
  // a `message`, de modo que ningun cliente existente quede en blanco.
  const emitir = (status: number, payload: RespuestaError): Response =>
    res.status(status).json({ ...payload, error: payload.message });

  switch (code) {
    case 'P2002': {
      const campo = campoDeMeta(err?.meta);
      return emitir(409, {
        success: false,
        code: 'DUPLICADO',
        message: `Ya existe un(a) ${recurso} con ese ${campo || 'valor único'}.`,
        campo: campo || undefined,
      });
    }
    case 'P2009':
    case 'P2011': {
      return emitir(400, {
        success: false,
        code: 'NULO_INVALIDO',
        message:
          'Faltan campos obligatorios o algún valor excede la longitud permitida.',
      });
    }
    case 'P2003': {
      return emitir(400, {
        success: false,
        code: 'FK_INVALIDA',
        message: 'La referencia a otro registro no es válida o no existe.',
      });
    }
    case 'P2025': {
      return emitir(404, {
        success: false,
        code: 'NO_ENCONTRADO',
        message: `${recurso.charAt(0).toUpperCase()}${recurso.slice(1)} no encontrado(a).`,
      });
    }
    default: {
      // Validaciones lanzadas por la capa de negocio (convención "VALIDACION:").
      if (typeof err?.message === 'string' && err.message.startsWith('VALIDACION:')) {
        return emitir(400, {
          success: false,
          code: 'NULO_INVALIDO',
          message: err.message.replace('VALIDACION:', '').trim(),
        });
      }
      return emitir(500, {
        success: false,
        code: 'ERROR_INTERNO',
        message: `Error al ${contexto} ${recurso === 'registro' ? 'el registro' : `el/la ${recurso}`}`,
      });
    }
  }
}