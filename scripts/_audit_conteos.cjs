// Auditoría de conteos: compara la ESTIMACIÓN de InnoDB
// (information_schema.TABLES.TABLE_ROWS) contra el conteo EXACTO (COUNT(*)).
//
// Motivo: el Monitor de BD mostraba TABLE_ROWS, que en InnoDB es una estimación.
// Se corrigió a COUNT(*) (monitor.controllers.ts). Este script mide la magnitud
// real del desvío, para no afirmar "estaba mal" sin número.
//
// Solo lectura. Uso: node scripts/_audit_conteos.cjs
require('dotenv').config();
const guard = require('./qa_guard.cjs');

// Salvaguarda del proyecto: todo script que CONECTA exige un destino local
// verificado ANTES de crear el cliente (ver qa_guard.cjs).
{
  const v = guard.validarHostLocal(process.env.DATABASE_URL || '');
  if (!v.ok) {
    console.error(`✖ ABORTADO: ${v.error} | destino=${guard.sanitizar(process.env.DATABASE_URL || '')}`);
    process.exit(3);
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TABLAS = [
  'usuarios', 'clientes', 'proveedores', 'categorias', 'productos', 'caja',
  'movimientos_caja', 'facturas', 'detalle_facturas', 'pagos',
  'notas_entrega_entrada', 'detalle_notas_entrega',
];

(async () => {
  const lista = TABLAS.map((t) => `'${t}'`).join(',');
  const estimados = await prisma.$queryRawUnsafe(
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS n
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${lista})`
  );
  const mapaEst = new Map(estimados.map((r) => [r.t, Number(r.n ?? 0)]));

  const union = TABLAS.map(
    (t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM \`${t}\``
  ).join(' UNION ALL ');
  const exactos = await prisma.$queryRawUnsafe(union);
  const mapaExa = new Map(exactos.map((r) => [r.t, Number(r.n ?? 0)]));

  console.log('tabla                      estimado    exacto   desvio');
  console.log('--------------------------------------------------------');
  let peor = 0;
  for (const t of TABLAS) {
    const e = mapaEst.get(t) ?? 0;
    const x = mapaExa.get(t) ?? 0;
    const d = x === 0 ? (e === 0 ? 0 : 100) : Math.abs((e - x) / x) * 100;
    peor = Math.max(peor, d);
    console.log(
      `${t.padEnd(26)} ${String(e).padStart(8)} ${String(x).padStart(8)} ${d.toFixed(1).padStart(8)}%`
    );
  }
  console.log(`\nDesvío máximo de la estimación: ${peor.toFixed(1)}%`);

  // Contexto del recorte del catálogo (soft-delete: las filas siguen existiendo).
  const p = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) AS total, SUM(Activo = 1) AS activos FROM productos'
  );
  const c = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) AS total, SUM(Activo = 1) AS activas FROM categorias'
  );
  console.log(
    `\nproductos  : total=${Number(p[0].total)}  activos=${Number(p[0].activos)}`
  );
  console.log(
    `categorias : total=${Number(c[0].total)}  activas=${Number(c[0].activas)}`
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
