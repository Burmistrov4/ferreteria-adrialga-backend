/**
 * Criterio de origen COMPARTIDO entre HTTP (CORS) y WebSocket (Socket.io).
 *
 * Extraído de `src/index.ts` para poder verificarlo con tests unitarios y
 * evitar que el canal WS quede abierto (`origin: '*'`) mientras el HTTP está
 * restringido. Un único punto de verdad.
 *
 * Regla de negocio de orígenes legítimos:
 *  - Producción Vercel: https://adrialga.vercel.app / *.vercel.app alias.
 *  - GitHub Pages: cualquier https://*.github.io (la cabecera Origin solo
 *    envía scheme+host).
 *  - Desarrollo: localhost / 127.0.0.1 / cualquier IP (LAN/WAN) mientras
 *    NODE_ENV !== 'production'. Flutter Web usa puertos dinámicos y la IP
 *    del equipo cambia entre redes, por eso en dev se permite cualquier IP.
 *  - Origen ausente (apps nativas Flutter, curl, Postman): permitido.
 *
 * En PRODUCCIÓN (NODE_ENV=production) SOLO se aceptan los orígenes explícitos
 * de ALLOWED_ORIGINS / CORS_ORIGINS / GitHub Pages. Cualquier otro → rechazado.
 */

export const ALLOWED_ORIGINS = [
  'https://adrialga.vercel.app', // Frontend producción (Vercel)
  'https://adrialga-frontend.vercel.app', // Alias alternativo
  'http://localhost:3000', // Desarrollo local Flutter web
  'http://localhost:5173', // Vite dev
];

export const esOrigenGitHubPages = (origin: string): boolean =>
  origin.startsWith('https://') && origin.endsWith('.github.io');

export const esOrigenPorIp = (origin: string): boolean =>
  /^https?:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(origin);

/**
 * ¿El `Origin` corresponde al MISMO host que está sirviendo la petición?
 *
 * Importa porque un navegador envía la cabecera `Origin` también en peticiones
 * del MISMO origen cuando el método no es GET/HEAD (login, ventas, caja...).
 * Esas peticiones NO son CORS: el navegador no las bloquea nunca y no necesitan
 * cabeceras `Access-Control-Allow-*`.
 *
 * Sin este atajo, el middleware las evaluaba contra la lista blanca y, en
 * producción sobre IP o dominio propio, las rechazaba — lo que en el despliegue
 * unificado (el backend sirve la web) significa un 500 en TODOS los POST.
 * Medido el 2026-10-15 antes de corregirlo.
 */
export const esMismoOrigen = (
  origin?: string | null,
  host?: string | null
): boolean => {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

/** Devuelve true solo si estamos en desarrollo Y el origen es local/IP. */
export const esOrigenLocalDev = (origin: string): boolean => {
  const esDesarrollo = (process.env.NODE_ENV ?? 'development') !== 'production';
  if (!esDesarrollo) return false;
  return (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    esOrigenPorIp(origin)
  );
};

/**
 * Valida si un `Origin` (cabecera HTTP o handshake WS) tiene permiso.
 * `origin` puede ser undefined cuando la petición no envía cabecera Origin
 * (apps nativas, curl, Postman) → se permite.
 *
 * `host` es la cabecera `Host` de la petición. Cuando se pasa, una petición del
 * MISMO origen se acepta siempre: no es una petición CORS y debe funcionar en
 * cualquier IP o dominio sin configuración adicional.
 *
 * Se evalúa NODE_ENV y CORS_ORIGINS en tiempo de ejecución para que las
 * pruebas puedan simular producción/dev fijando esas variables.
 */
export const esOrigenPermitido = (
  origin?: string | null,
  host?: string | null
): boolean => {
  if (!origin) return true;
  if (esMismoOrigen(origin, host)) return true;
  const EXTRA_ORIGINS = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    esOrigenLocalDev(origin) ||
    esOrigenGitHubPages(origin) ||
    EXTRA_ORIGINS.includes(origin) ||
    ALLOWED_ORIGINS.includes(origin)
  );
};
