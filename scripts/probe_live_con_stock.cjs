#!/usr/bin/env node
/** Conecta a un servidor YA CORRIENDO (BASE env) y verifica health + conStock (GET, read-only). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const root = path.resolve(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
function get(ruta, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + ruta);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}`, Origin: BASE } : { Origin: BASE } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, raw })); });
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('timeout'))); req.end();
  });
}
async function main() {
  const h = await get('/api/health', '');
  console.log('health:', h.status, h.raw.replace(/\s+/g, ' ').trim());
  const token = jwt.sign({ Usuario_ID: 1, Nombre: 'QA', Rol: 'ADMIN' }, env.JWT_SECRET, { expiresIn: '1h' });
  const a = await get('/api/productos?limit=500', token);
  const b = await get('/api/productos?limit=500&conStock=1', token);
  const all = JSON.parse(a.raw);
  const solo = JSON.parse(b.raw);
  const cumple = solo.every((p) => (p.Stock_Actual ?? 0) > 0);
  const agotados = all.filter((p) => (p.Stock_Actual ?? 0) <= 0).length;
  console.log(`total=${all.length} soloConStock=${solo.length} agotados=${agotados}`);
  console.log('conStock=1 solo stock>0:', cumple ? 'PASS' : 'FAIL');
  console.log('filtro efectivo:', agotados > 0 && solo.length < all.length ? 'PASS' : (agotados === 0 ? 'N/A' : 'FAIL'));
  process.exit(cumple && solo.length <= all.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
