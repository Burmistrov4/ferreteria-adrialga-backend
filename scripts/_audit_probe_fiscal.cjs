/**
 * _audit_probe_fiscal.cjs — sonda de auditoría (temporal).
 *
 * Firma un JWT local y verifica: (1) el Resumen de IVA ahora exporta CSV con
 * ';' + BOM + CRLF, (2) el Libro Diario usa CRLF. Nunca imprime el secreto.
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const token = jwt.sign(
  { Usuario_ID: 1, Nombre: 'Auditor', Rol: 'Administrador' },
  env.JWT_SECRET,
  { expiresIn: '5m' }
);
const H = { Authorization: `Bearer ${token}` };

async function traer(url) {
  const r = await fetch(url, { headers: H });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ctype: r.headers.get('content-type'), buf };
}

(async () => {
  const anio = new Date().getFullYear();
  const mes = new Date().getMonth() + 1;
  const q = `anio=${anio}&mes=${mes}`;

  const iva = await traer(`http://127.0.0.1:3000/api/seniat/resumen-iva?${q}&formato=csv`);
  const txt = iva.buf.toString('utf8');
  console.log(
    `resumen-iva csv  http=${iva.status} ctype=${iva.ctype} ` +
      `bom=${iva.buf[0] === 0xef && iva.buf[1] === 0xbb && iva.buf[2] === 0xbf} ` +
      `crlf=${txt.includes('\r\n')} lineas=${txt.split('\r\n').length}`
  );

  const diario = await traer(`http://127.0.0.1:3000/api/dashboard/exportar?formato=csv`);
  const dtxt = diario.buf.toString('utf8');
  console.log(
    `libro diario csv http=${diario.status} ` +
      `bom=${diario.buf[0] === 0xef} crlf=${dtxt.includes('\r\n')} ` +
      `lf_solo=${/\n/.test(dtxt.replace(/\r\n/g, ''))}`
  );
})();
