'use strict';
/**
 * qa_guard.cjs — Validación de destino de base de datos para pruebas QA (ADR-002/007).
 *
 * ÚNICA FUENTE DE VERDAD para run_qa_e2e.mjs, setup_qa_db.cjs,
 * test_dashboard_metricas.ts y cualquier script que escriba en MySQL.
 * NO conecta a la BD; solo parsea y valida la URL.
 *
 * Reglas (mega prompt §3 y §5):
 *  - protocolo permitido: mysql: o mysql2: (insensible a mayúsculas)
 *  - host loopback obligatorio: localhost | 127.0.0.1 | ::1 (alias canónicos)
 *  - nombre de base objetivo EXACTAMENTE 'adrialga_qa' (ruta única, sin extras)
 *  - la URL real NO debe apuntar ya a 'adrialga_qa' (no derivar QA desde sí misma)
 *  - QA y real no deben coincidir (mismo host canónico + misma base lógica),
 *    incluso si se refieren al mismo servidor con alias distintos (localhost vs 127.0.0.1)
 *  - NUNCA se devuelve ni imprime usuario/contraseña/query
 *
 * Códigos de salida: 3 = aborto por seguridad (sin conexión).
 */

const ALLOWED_PROTOCOLS = ['mysql:', 'mysql2:'];
const QA_DB = 'adrialga_qa';

// Aliases de loopback -> forma canónica para detección de colisión.
const LOOPBACK_CANON = {
  localhost: 'loopback',
  '127.0.0.1': 'loopback',
  '::1': 'loopback',
};

/** Normaliza una URL cruda: quita comillas/backticks/espacios envolventes. */
function normalizarUrl(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '');
}

/** Parsea de forma segura; devuelve URL o null. Aplica normalizarUrl. */
function parsear(raw) {
  const s = normalizarUrl(raw);
  if (!s) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Host canónico (corchetes IPv6 quitados, minúsculas). */
function extraerHost(u) {
  return (u && u.hostname ? u.hostname : '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/** Host canónico para colisión (localhost/127.0.0.1/[::1] -> 'loopback'). */
function hostCanonico(u) {
  const h = extraerHost(u);
  return LOOPBACK_CANON[h] || h;
}

/**
 * Ruta limpia: quita barras iniciales/finales y normaliza.
 * Para base exacta debe ser un único segmento === QA_DB.
 */
function rutaLimpia(u) {
  return (u && u.pathname ? u.pathname : '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Extrae la base (primer segmento de ruta). */
function extraerBase(u) {
  const r = rutaLimpia(u);
  return (r.split('/')[0] || '').trim();
}

/** ¿La ruta es EXACTAMENTE /adrialga_qa (un solo segmento, sin extras)? */
function esRutaQaExacta(u) {
  const r = rutaLimpia(u);
  return r === QA_DB && r.split('/').length === 1;
}

/**
 * Devuelve solo host y base, SIN credenciales ni query. Para cualquier registro.
 */
function sanitizar(urlString) {
  const u = parsear(urlString);
  if (!u) return '(URL inválida)';
  return `host=${u.host} base=${extraerBase(u)}`;
}

/** Valida que la URL REAL sea local (host loopback) y base != adrialga_qa. */
function validarLocal(realUrl) {
  const u = parsear(realUrl);
  if (!u) return { ok: false, error: 'URL malformada', code: 3 };
  const proto = (u.protocol || '').toLowerCase();
  if (!ALLOWED_PROTOCOLS.includes(proto)) {
    return { ok: false, error: `protocolo no permitido (${proto || 'vacío'})`, code: 3 };
  }
  if (!LOOPBACK_CANON[extraerHost(u)]) {
    return { ok: false, error: `host no loopback (${extraerHost(u) || 'vacío'})`, code: 3 };
  }
  if (extraerBase(u) === QA_DB) {
    return {
      ok: false,
      error: 'la URL real ya apunta a adrialga_qa; no se puede derivar QA desde sí misma',
      code: 3,
    };
  }
  return { ok: true, host: extraerHost(u), db: extraerBase(u), url: u };
}

/** Deriva la URL de QA desde la real (solo si real local y base != adrialga_qa). */
function derivarUrlQa(realUrl) {
  const v = validarLocal(realUrl);
  if (!v.ok) return v; // { ok:false, error, code }
  const u = v.url;
  u.pathname = '/' + QA_DB;
  return { ok: true, qaUrl: u.toString(), host: u.host, db: QA_DB };
}

/**
 * Valida que la URL QA sea un destino seguro de escritura:
 *  - protocolo permitido
 *  - host loopback
 *  - ruta EXACTAMENTE /adrialga_qa (sin segmentos extra)
 *  - QA y real no coinciden (mismo host canónico + misma base)
 */
function validarUrlQa(qaUrl, realUrl) {
  const u = parsear(qaUrl);
  if (!u) return { ok: false, error: 'URL QA malformada', code: 3 };
  const proto = (u.protocol || '').toLowerCase();
  if (!ALLOWED_PROTOCOLS.includes(proto)) {
    return { ok: false, error: `protocolo QA no permitido (${proto || 'vacío'})`, code: 3 };
  }
  if (!LOOPBACK_CANON[extraerHost(u)]) {
    return { ok: false, error: `host QA no loopback (${extraerHost(u) || 'vacío'})`, code: 3 };
  }
  if (!esRutaQaExacta(u)) {
    const r = rutaLimpia(u);
    return {
      ok: false,
      error: `ruta QA debe ser exactamente '/${QA_DB}' (recibido '/${r || 'vacío'}')`,
      code: 3,
    };
  }
  // Colisión: mismo host canónico + misma base lógica (incluso por alias distintos).
  const ru = parsear(realUrl);
  if (ru) {
    if (hostCanonico(ru) === hostCanonico(u) && extraerBase(ru) === QA_DB) {
      return { ok: false, error: 'URL QA coincide con la base real (mismo host+base)', code: 3 };
    }
  }
  return { ok: true, host: extraerHost(u), db: QA_DB, url: u };
}

/**
 * Para scripts de admin/migración que operan SOBRE la BD real local:
 * rechaza todo lo que no sea loopback (nunca operar en remoto sin confirmación).
 */
function validarHostLocal(cualquierUrl) {
  const u = parsear(cualquierUrl);
  if (!u) return { ok: false, error: 'URL malformada', code: 3 };
  if (!LOOPBACK_CANON[extraerHost(u)]) {
    return { ok: false, error: `host no loopback (${extraerHost(u) || 'vacío'})`, code: 3 };
  }
  return { ok: true, host: extraerHost(u), db: extraerBase(u) };
}

module.exports = {
  ALLOWED_PROTOCOLS,
  QA_DB,
  LOOPBACK_CANON,
  normalizarUrl,
  parsear,
  extraerHost,
  hostCanonico,
  rutaLimpia,
  extraerBase,
  esRutaQaExacta,
  sanitizar,
  validarLocal,
  derivarUrlQa,
  validarUrlQa,
  validarHostLocal,
};
