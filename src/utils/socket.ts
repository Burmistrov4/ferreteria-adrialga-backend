import type { Server } from 'socket.io';

/**
 * Repositorio del servidor Socket.IO (se llena desde index.ts al arrancar).
 * Los controllers leen IoStore.io para emitir eventos globales sin referencias
 * circulares entre index.ts (servidor) y el stack de rutas/controllers.
 */
export class IoStore {
  static io: Server | null = null;

  static init(io: Server) {
    IoStore.io = io;
  }

  static emitDbUpdate(modulo: string, mensaje: string, extra: Record<string, unknown> = {}) {
    if (!IoStore.io) return;
    IoStore.io.emit('db_update', {
      modulo,
      mensaje,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }
}
