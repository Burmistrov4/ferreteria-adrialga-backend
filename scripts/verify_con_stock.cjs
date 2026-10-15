#!/usr/bin/env node
/**
 * verify_con_stock.cjs — Verifica el filtro de servidor `conStock` (feature
 * "Productos con existencia" del POS/Inventario). Corre SOLO contra adrialga_qa.
 * No imprime credenciales.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '..');
const PORT = 3997;
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const JWT_SECRET = env.JWT_SECRET;
const guard = require('./qa_guard.cjs');
const realUrl = env.DATABASE_URL;
const _vReal = guard.validarLocal(realUrl);
if (!_vReal.ok) {
  console.error(`ABORTADO: DATABASE_URL real no es local válida (${guard.sanitizar(realUrl)}): ${_vReal.error}`);
  process.exit(3);
}
const _d = guard.derivarUrlQa(realUrl);
if (!_d.ok) { console.error(`ABORTADO: no se pudo derivar QA (${guard.sanitizar(realUrl)}): ${_d.error}`); process.exit(3); }
const qaUrl = _d.qaUrl;

const hijo = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', JWT_SECRET, PORT: String(PORT), DATABASE_URL: qaUrl },
  stdio: 'ignore',
});
const cleanup = () => { try { hijo.kill(); } catch {} };
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(ruta, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: PORT, path: ruta, method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Origin: `http://localhost:${PORT}` },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
async function waitHealth(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const r = await get('/api/health', ''); if (r.status === 200 && r.raw.includes('connected')) return true; } catch {}
    await sleep(500);
  }
  return false;
}

async function main() {
  if (!await waitHealth()) { console.log('FAIL: servidor QA no arrancó'); cleanup(); process.exit(1); }
  const { PrismaClient } = require(path.join(root, 'node_modules', '@prisma', 'client'));
  const prisma = new PrismaClient({ datasources: { db: { url: qaUrl } } });
  const tag = Date.now().toString(36);
  const skus = [`QA-STOCK-${tag}`, `QA-AGOTADO-${tag}`];
  let categoriaId;
  try {
    const categoria = await prisma.categorias.create({ data: { Nombre: `QA stock ${tag}`, Prefijo_SKU: 'QA' } });
    categoriaId = categoria.Categoria_ID;
    await prisma.productos.createMany({ data: [
      { SKU_Codigo: skus[0], Nombre: 'QA producto con existencia', Stock_Actual: 4, Categoria_ID: categoriaId },
      { SKU_Codigo: skus[1], Nombre: 'QA producto agotado', Stock_Actual: 0, Categoria_ID: categoriaId },
    ] });

    const token = jwt.sign({ Usuario_ID: 1, Nombre: 'QA', Rol: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
    const t0 = await get('/api/productos?limit=500', token);
    const t1 = await get('/api/productos?limit=500&conStock=1', token);
    const t2 = await get('/api/productos?limit=500&sinStock=1', token);
    const t3 = await get('/api/productos?limit=10&conStock=1&sinStock=1', token);

    const all = JSON.parse(t0.raw);
    const soloStock = JSON.parse(t1.raw);
    const sinStock = JSON.parse(t2.raw);
    const conStock0 = all.filter((p) => (p.Stock_Actual ?? 0) > 0).length;
    const agotados = all.filter((p) => (p.Stock_Actual ?? 0) <= 0).length;
    const fixtureCon = all.some((p) => p.SKU_Codigo === skus[0]);
    const fixtureSin = all.some((p) => p.SKU_Codigo === skus[1]);
    const cumpleCon = soloStock.every((p) => (p.Stock_Actual ?? 0) > 0) && soloStock.some((p) => p.SKU_Codigo === skus[0]) && !soloStock.some((p) => p.SKU_Codigo === skus[1]);
    const cumpleSin = sinStock.every((p) => (p.Stock_Actual ?? 0) <= 0) && sinStock.some((p) => p.SKU_Codigo === skus[1]) && !sinStock.some((p) => p.SKU_Codigo === skus[0]);
    const sinDuplicados = soloStock.every((p) => !sinStock.some((s) => s.Producto_ID === p.Producto_ID));
    const cobertura = soloStock.length + sinStock.length === all.length;

    console.log(`total=${all.length} conStock=${conStock0} agotados=${agotados} soloConStock=${soloStock.length} soloSinStock=${sinStock.length}`);
    console.log(`fixtures QA presentes: ${fixtureCon && fixtureSin ? 'PASS' : 'FAIL'}`);
    console.log(`conStock=1 filtra correctamente y excluye el agotado: ${cumpleCon ? 'PASS' : 'FAIL'}`);
    console.log(`sinStock=1 filtra correctamente y excluye el producto con stock: ${cumpleSin ? 'PASS' : 'FAIL'}`);
    console.log(`los conjuntos con/sin stock no se solapan: ${sinDuplicados ? 'PASS' : 'FAIL'}`);
    console.log(`filtros cubren el catálogo consultado: ${cobertura ? 'PASS' : 'FAIL'}`);
    console.log(`ambos filtros simultáneos se rechazan con HTTP 400: ${t3.status === 400 ? 'PASS' : 'FAIL'}`);
    process.exitCode = fixtureCon && fixtureSin && cumpleCon && cumpleSin && sinDuplicados && cobertura && t3.status === 400 ? 0 : 1;
  } finally {
    await prisma.productos.deleteMany({ where: { SKU_Codigo: { in: skus } } });
    if (categoriaId) await prisma.categorias.deleteMany({ where: { Categoria_ID: categoriaId } });
    await prisma.$disconnect();
    cleanup();
  }
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
