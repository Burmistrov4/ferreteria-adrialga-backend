/**
 * test_cors_validator.ts — verifica el validador de orígenes COMPARTIDO entre
 * HTTP (CORS) y WebSocket (Socket.io) en src/utils/cors.ts.
 *
 * Responde a la VERIFICACIÓN DE SEGURIDAD CRÍTICA del megaprompt:
 *  - Confirmar que el validador acepta los orígenes legítimos del frontend
 *    (Vercel, GitHub Pages, localhost/LAN en dev, app nativa sin Origin).
 *  - Confirmar que RECHAZA orígenes rogue en PRODUCCIÓN (NODE_ENV=production).
 *
 * No requiere base de datos. Solo importa la función pura esOrigenPermitido.
 *
 * Códigos de salida: 0 = TODO PASS · 1 = alguna aserción falló · 3 = skip.
 */
import { esOrigenPermitido } from '../src/utils/cors';

const fallos: string[] = [];
function chequea(nombre: string, ok: boolean, detalle = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${nombre}${detalle ? ` · ${detalle}` : ''}`);
  if (!ok) fallos.push(nombre);
}

// Helper: fijar entorno y correr un subconjunto.
function enEntorno(nodeEnv: string, corsOrigins = '') {
  process.env.NODE_ENV = nodeEnv;
  process.env.CORS_ORIGINS = corsOrigins;
}

console.log('== DEV (NODE_ENV no es production): LAN/local permitidos ==');
enEntorno('development');
chequea('DEV: origen Vercel permitido', esOrigenPermitido('https://adrialga.vercel.app'));
chequea('DEV: alias Vercel permitido', esOrigenPermitido('https://adrialga-frontend.vercel.app'));
chequea('DEV: GitHub Pages permitido', esOrigenPermitido('https://lorenzo.github.io'));
// Nota: la cabecera Origin es scheme://host (NUNCA incluye path), por eso el
// caso válido es https://user.github.io, no https://user.github.io/foo.
chequea('DEV: subdominio GitHub Pages permitido', esOrigenPermitido('https://user.github.io'));
chequea('DEV: localhost:3000 permitido', esOrigenPermitido('http://localhost:3000'));
chequea('DEV: localhost:5173 permitido', esOrigenPermitido('http://localhost:5173'));
chequea('DEV: 127.0.0.1 permitido', esOrigenPermitido('http://127.0.0.1:8080'));
chequea('DEV: IP LAN permitido', esOrigenPermitido('http://192.168.1.50:1234'));
chequea('DEV: IP pública/WAN permitido', esOrigenPermitido('http://25.36.124.34:3000'));
chequea('DEV: origen ausente (app nativa) permitido', esOrigenPermitido(undefined));
chequea('DEV: CORS_ORIGINS extra permitido', (enEntorno('development', 'https://staging.adrialga.com'), esOrigenPermitido('https://staging.adrialga.com')));
chequea('DEV: origen rogue denegado', !esOrigenPermitido('https://evil-attacker.com'));

console.log('\n== PRODUCCIÓN (NODE_ENV=production): SOLO orígenes explícitos/GitHub Pages ==');
enEntorno('production');
chequea('PROD: Vercel permitido', esOrigenPermitido('https://adrialga.vercel.app'));
chequea('PROD: GitHub Pages permitido', esOrigenPermitido('https://lorenzo.github.io'));
chequea('PROD: origen ausente (app nativa) permitido', esOrigenPermitido(undefined));
chequea('PROD: CORS_ORIGINS extra permitido', (enEntorno('production', 'https://staging.adrialga.com'), esOrigenPermitido('https://staging.adrialga.com')));
// En producción el loopback explícitamente whitelist (localhost:3000/5173) SÍ se
// permite (es seguro: no puede ser spoofeado por un atacante remoto). Lo que se
// deniega es cualquier IP/LAN/puerto no listado.
chequea('PROD: localhost:3000 permitido (whitelist loopback)', esOrigenPermitido('http://localhost:3000'));
chequea('PROD: localhost puerto arbitrario DENEGADO', !esOrigenPermitido('http://localhost:9999'));
chequea('PROD: 127.0.0.1 DENEGADO', !esOrigenPermitido('http://127.0.0.1:8080'));
chequea('PROD: IP LAN DENEGADO', !esOrigenPermitido('http://192.168.1.50:1234'));
chequea('PROD: IP pública DENEGADO', !esOrigenPermitido('http://25.36.124.34:3000'));
chequea('PROD: origen rogue DENEGADO', !esOrigenPermitido('https://evil-attacker.com'));

console.log('\n== RESUMEN ==');
if (fallos.length === 0) {
  console.log('TODO PASS · validador CORS coherente con orígenes legítimos del frontend');
} else {
  console.error(`FALLARON ${fallos.length}: ${fallos.join(', ')}`);
  process.exitCode = 1;
}
