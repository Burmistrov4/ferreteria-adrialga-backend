// Auditoría de IMÁGENES de producto: ¿cuánto pesa realmente lo que hay que
// desplegar?
//
// Motivo: `public/productos` pesa 193 MB con 7.211 archivos y NO está en git,
// así que ningún PaaS lo serviría (catálogo con imágenes rotas). Antes de
// aceptar "hay que borrar las imágenes", se mide cuántas hacen falta de verdad.
//
// Un producto inactivo (soft-delete) sigue siendo necesario si aparece en una
// factura o nota de entrega: al reimprimir un documento histórico la imagen
// debe seguir resolviendo. Ese conjunto es el "mínimo imprescindible".
//
// Solo lectura. Uso: node scripts/_audit_imagenes.cjs
require('dotenv').config();
const fs = require('fs');
const path = require('path');
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

const DIR = path.resolve(__dirname, '../public/productos');

/** Nombre de archivo que corresponde a un Imagen_URL, o null si no aplica. */
function archivoDe(imagenUrl) {
  if (!imagenUrl) return null;
  const s = String(imagenUrl).trim();
  if (!s) return null;
  // Se acepta tanto '/productos/X.webp' como una URL absoluta o solo 'X.webp'.
  const base = s.split('/').pop().split('?')[0];
  return base || null;
}

(async () => {
  // ── 1. Inventario en disco ────────────────────────────────────────────────
  const enDisco = new Map();
  if (!fs.existsSync(DIR)) {
    console.error(`✖ No existe el directorio de imágenes: ${DIR}`);
    process.exit(2);
  }
  for (const f of fs.readdirSync(DIR)) {
    const abs = path.join(DIR, f);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isFile()) enDisco.set(f, st.size);
  }
  const bytesDisco = [...enDisco.values()].reduce((a, b) => a + b, 0);

  // ── 2. Productos: activos, inactivos y los citados en documentos ──────────
  const todos = await prisma.productos.findMany({
    select: { Producto_ID: true, SKU_Codigo: true, Imagen_URL: true, Activo: true },
  });
  const activos = todos.filter((p) => p.Activo);
  const inactivos = todos.filter((p) => !p.Activo);

  // Productos con movimiento documental: aparecen en una factura o en una nota
  // de entrega. Aunque estén inactivos, su imagen debe seguir disponible.
  const conDocumentos = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT Producto_ID FROM detalle_facturas
    UNION
    SELECT DISTINCT Producto_ID FROM detalle_notas_entrega
  `);
  const idsConDoc = new Set(conDocumentos.map((r) => Number(r.Producto_ID)));

  // ── 3. Conjuntos necesarios ───────────────────────────────────────────────
  const esNecesario = (p) => p.Activo || idsConDoc.has(p.Producto_ID);

  const resumen = {
    disco: { archivos: enDisco.size, bytes: bytesDisco },
    activos: { total: activos.length, conUrl: 0, archivosOk: 0, bytes: 0 },
    necesarios: { total: 0, conUrl: 0, archivosOk: 0, bytes: 0, faltantes: [] },
    huerfanos: { archivos: 0, bytes: 0 },
  };

  const archivosNecesarios = new Set();

  for (const p of todos) {
    const arch = archivoDe(p.Imagen_URL);
    const peso = arch && enDisco.has(arch) ? enDisco.get(arch) : 0;

    if (p.Activo) {
      if (arch) resumen.activos.conUrl++;
      if (peso > 0) {
        resumen.activos.archivosOk++;
        resumen.activos.bytes += peso;
      }
    }

    if (esNecesario(p)) {
      resumen.necesarios.total++;
      if (arch) resumen.necesarios.conUrl++;
      if (peso > 0) {
        resumen.necesarios.archivosOk++;
        resumen.necesarios.bytes += peso;
      } else if (arch) {
        resumen.necesarios.faltantes.push(`${p.SKU_Codigo} -> ${arch}`);
      }
      if (arch && enDisco.has(arch)) archivosNecesarios.add(arch);
    }
  }

  // ── 4. Huérfanos: archivos en disco que ningún producto necesita ─────────
  for (const [f, size] of enDisco) {
    if (!archivosNecesarios.has(f)) {
      resumen.huerfanos.archivos++;
      resumen.huerfanos.bytes += size;
    }
  }

  const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
  const pct = (a, b) => (b === 0 ? '0' : ((a / b) * 100).toFixed(1)) + '%';

  console.log('=== IMÁGENES DE PRODUCTO: qué hay que desplegar de verdad ===\n');
  console.log(`En disco          : ${resumen.disco.archivos} archivos · ${mb(resumen.disco.bytes)}`);
  console.log(`Productos totales : ${todos.length} (activos ${activos.length} · inactivos ${inactivos.length})`);
  console.log(`Citados en docs   : ${idsConDoc.size} productos con movimiento documental\n`);

  console.log('--- MÍNIMO IMPRESCINDIBLE (activos + citados en facturas/notas) ---');
  console.log(`  productos        : ${resumen.necesarios.total}`);
  console.log(`  con Imagen_URL   : ${resumen.necesarios.conUrl}`);
  console.log(`  archivos en disco: ${resumen.necesarios.archivosOk}`);
  console.log(`  peso             : ${mb(resumen.necesarios.bytes)}  (${pct(resumen.necesarios.bytes, resumen.disco.bytes)} del total)`);
  console.log(`  peso único       : ${archivosNecesarios.size} archivos distintos`);
  if (resumen.necesarios.faltantes.length) {
    console.log(`  ⚠ sin archivo    : ${resumen.necesarios.faltantes.length}`);
    for (const f of resumen.necesarios.faltantes.slice(0, 10)) console.log(`      ${f}`);
  }

  console.log('\n--- HUÉRFANOS (ningún producto los necesita) ---');
  console.log(`  ${resumen.huerfanos.archivos} archivos · ${mb(resumen.huerfanos.bytes)}`);

  console.log('\n--- IMPACTO EN EL DESPLIEGUE ---');
  console.log(`  desplegar todo    : ${mb(resumen.disco.bytes)}`);
  console.log(`  desplegar mínimo  : ${mb(resumen.necesarios.bytes)}`);
  console.log(`  ahorro            : ${mb(resumen.disco.bytes - resumen.necesarios.bytes)}`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
