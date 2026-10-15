// Exporta a una carpeta de despliegue SOLO las imágenes de producto que el
// sistema puede llegar a mostrar.
//
// Motivo medido el 2026-10-15: `public/productos` tiene 7.211 archivos / 177 MB
// pero solo 100 productos están activos y únicamente 58 más aparecen en
// documentos históricos. El conjunto imprescindible son 91 archivos / 2,2 MB
// (1,2 % del total). Los otros 7.120 (174,7 MB) pertenecen a productos con
// borrado lógico que ninguna pantalla ni documento referencia.
//
// Este script NO borra nada: copia el subconjunto necesario a un directorio
// aparte y deja un manifiesto. El catálogo local sigue intacto.
//
// Uso:  node scripts/exportar_imagenes_deploy.cjs [--destino <ruta>] [--limpiar]
//   --destino  carpeta de salida (por defecto public/productos_deploy, DENTRO
//              del repositorio del backend: en un PaaS como Render el sistema de
//              archivos es efímero y solo se despliega lo versionado)
//   --limpiar  borra SOLO dentro del destino los archivos que ya no se necesitan
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

const ORIGEN = path.resolve(__dirname, '../public/productos');

function leerArgs() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--destino');
  const destino =
    i >= 0 && argv[i + 1]
      ? argv[i + 1]
      : path.resolve(__dirname, '../public/productos_deploy');
  return { destino: path.resolve(destino), limpiar: argv.includes('--limpiar') };
}

function archivoDe(imagenUrl) {
  if (!imagenUrl) return null;
  const s = String(imagenUrl).trim();
  if (!s) return null;
  const base = s.split('/').pop().split('?')[0];
  return base || null;
}

(async () => {
  const { destino, limpiar } = leerArgs();

  if (!fs.existsSync(ORIGEN)) {
    console.error(`✖ No existe el directorio de origen: ${ORIGEN}`);
    process.exit(2);
  }

  // ── 1. Qué productos hay que poder mostrar ────────────────────────────────
  const todos = await prisma.productos.findMany({
    select: { Producto_ID: true, SKU_Codigo: true, Imagen_URL: true, Activo: true },
  });
  const conDoc = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT Producto_ID FROM detalle_facturas
    UNION
    SELECT DISTINCT Producto_ID FROM detalle_notas_entrega
  `);
  const idsConDoc = new Set(conDoc.map((r) => Number(r.Producto_ID)));

  const necesarios = new Map(); // archivo -> {sku, motivo}
  let sinArchivo = 0;
  for (const p of todos) {
    const requerido = p.Activo || idsConDoc.has(p.Producto_ID);
    if (!requerido) continue;
    const arch = archivoDe(p.Imagen_URL);
    if (!arch) continue;
    if (!fs.existsSync(path.join(ORIGEN, arch))) {
      sinArchivo++;
      continue;
    }
    if (!necesarios.has(arch)) {
      necesarios.set(arch, { sku: p.SKU_Codigo, motivo: p.Activo ? 'activo' : 'citado en documento' });
    }
  }

  // ── 2. Copiar ─────────────────────────────────────────────────────────────
  fs.mkdirSync(destino, { recursive: true });
  let copiados = 0;
  let omitidos = 0;
  let bytes = 0;

  for (const [arch, meta] of necesarios) {
    const src = path.join(ORIGEN, arch);
    const dst = path.join(destino, arch);
    const size = fs.statSync(src).size;
    bytes += size;

    // Copia idempotente: si ya está con el mismo tamaño, no se toca.
    if (fs.existsSync(dst) && fs.statSync(dst).size === size) {
      omitidos++;
      continue;
    }
    fs.copyFileSync(src, dst);
    copiados++;
  }

  // ── 3. Limpieza OPCIONAL, acotada al destino ──────────────────────────────
  let borrados = 0;
  if (limpiar && fs.existsSync(destino)) {
    for (const f of fs.readdirSync(destino)) {
      if (f === 'manifiesto.json') continue;
      if (necesarios.has(f)) continue;
      const abs = path.join(destino, f);
      if (fs.statSync(abs).isFile()) {
        fs.unlinkSync(abs);
        borrados++;
      }
    }
  }

  // ── 4. Manifiesto ─────────────────────────────────────────────────────────
  const manifiesto = {
    generadoEn: new Date().toISOString(),
    origen: ORIGEN,
    destino,
    archivos: necesarios.size,
    bytes,
    productosActivos: todos.filter((p) => p.Activo).length,
    productosCitadosEnDocumentos: idsConDoc.size,
    sinArchivoEnDisco: sinArchivo,
    detalle: [...necesarios.entries()]
      .map(([arch, m]) => ({ archivo: arch, sku: m.sku, motivo: m.motivo }))
      .sort((a, b) => a.archivo.localeCompare(b.archivo)),
  };
  fs.writeFileSync(path.join(destino, 'manifiesto.json'), JSON.stringify(manifiesto, null, 2));

  const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
  console.log('=== EXPORTACIÓN DE IMÁGENES PARA DESPLIEGUE ===\n');
  console.log(`  origen            : ${ORIGEN}`);
  console.log(`  destino           : ${destino}`);
  console.log(`  archivos necesarios: ${necesarios.size} · ${mb(bytes)}`);
  console.log(`  copiados          : ${copiados}`);
  console.log(`  ya al día         : ${omitidos}`);
  console.log(`  borrados (--limpiar): ${borrados}`);
  if (sinArchivo) console.log(`  ⚠ productos requeridos sin archivo: ${sinArchivo}`);
  console.log(`\n  manifiesto: ${path.join(destino, 'manifiesto.json')}`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
