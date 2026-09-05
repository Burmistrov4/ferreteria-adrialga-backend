/**
 * PRUEBA DE HUMO E2E — Ciclo comercial completo (Certificación)
 * Recepción de Stock → Recálculo CMP → Venta → Impacto en Caja → Exportación CSV
 * Ejecutar con el backend corriendo en :3000:  node scripts/smoke_e2e.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:3000/api';

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

(async () => {
  // ── 0. Login ──
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  });
  assert(loginRes.ok, `Login (HTTP ${loginRes.status})`);
  const { token } = await loginRes.json();
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── 1. Preparación: categoría + producto con nombre hostil (comillas/comas) ──
  let cats = await (await fetch(`${BASE}/categorias`, { headers: auth })).json();
  let cat = Array.isArray(cats) ? cats[0] : cats.categorias?.[0];
  if (!cat) {
    cat = await (await fetch(`${BASE}/categorias`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ Nombre: 'HUMO E2E', Prefijo_SKU: 'HUM' })
    })).json();
  }
  const catId = cat.Categoria_ID ?? cat.id;
  assert(!!catId, `Categoría disponible (ID ${catId})`);

  const nombreProducto = 'Producto Humo E2E (Con "comillas", y comas)';
  const prodRes = await (await fetch(`${BASE}/productos`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Nombre: nombreProducto, Precio_Venta: 5.0, Stock_Actual: 0,
      Stock_Minimo: 5, Costo_Promedio: 0, Categoria_ID: catId
    })
  })).json();
  const producto = prodRes.producto ?? prodRes;
  const prodId = producto.Producto_ID;
  assert(!!prodId, `Producto creado (ID ${prodId}, SKU ${producto.SKU_Codigo ?? 'n/a'})`);
  assert(/^[A-Z]{3}-\d{4}-\d{4}$/.test(producto.SKU_Codigo || ''), `SKU autogenerado: ${producto.SKU_Codigo}`);

  // ── 2. Entrada de mercancía (Contado, costo 2.50 × 10) ──
  const notaRes = await (await fetch(`${BASE}/notas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Numero_Nota: `SMOKE-${Date.now()}`, Forma_Pago: 'Contado',
      detalles: [{ Producto_ID: prodId, Cantidad: 10, Costo_Unitario: 2.5 }]
    })
  })).json();
  assert(notaRes.nota || notaRes.message, `Entrada registrada: ${notaRes.message ?? 'ok'}`);

  const p1 = await prisma.productos.findUnique({ where: { Producto_ID: prodId } });
  assert(Number(p1.Stock_Actual) === 10, `Stock a 10 (= ${Number(p1.Stock_Actual)})`);
  assert(Math.abs(Number(p1.Costo_Promedio) - 2.5) < 0.0001, `CMP recalculado a 2.5000 (= ${Number(p1.Costo_Promedio)})`);
  const cajaTrasEntrada = await prisma.caja.findFirst({ where: { Activa: true } });
  console.log(`INFO  Caja tras entrada Contado (EGRESO): ${Number(cajaTrasEntrada.Saldo_Actual)}`);

  // ── 3. Venta → congela CMP, descuenta stock ──
  // Cliente de prueba con nombre hostil (comillas y comas) para validar escape CSV
  let cliente = await prisma.clientes.findUnique({ where: { RIF_Cedula: 'V-99999999' } });
  if (!cliente) {
    cliente = await prisma.clientes.create({
      data: { RIF_Cedula: 'V-99999999', Razon_Social: 'Cliente "Prueba", S.A. (E2E)' }
    });
  }
  const tasaRes = await (await fetch(`${BASE}/scraping/bcv`, { headers: auth })).json();
  const tasa = Number(tasaRes.tasa);
  assert(tasa > 0, `Tasa BCV del microservicio: ${tasa}`);

  const cmpAntesVenta = Number(p1.Costo_Promedio);
  const facRes = await (await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID,
      detalles: [{ Producto_ID: prodId, Cantidad: 3, Precio_Unitario: 5.0 }],
      Tasa_Cambio: tasa,
      Detalles_Pago: { efectivoUSD: 17.4 } // 15 base + 2.4 IVA 16%
    })
  })).json();
  assert(!!facRes.factura, `Factura emitida (ID ${facRes.factura?.Factura_ID})`);
  const facturaId = facRes.factura.Factura_ID;

  const detalle = await prisma.detalle_facturas.findFirst({ where: { Factura_ID: facturaId } });
  assert(Math.abs(Number(detalle.Costo_Unitario_Historico) - cmpAntesVenta) < 0.0001,
    `Costo_Unitario_Historico congelado = CMP (${Number(detalle.Costo_Unitario_Historico)})`);
  const p2 = await prisma.productos.findUnique({ where: { Producto_ID: prodId } });
  assert(Number(p2.Stock_Actual) === 7, `Stock descontado a 7 (= ${Number(p2.Stock_Actual)})`);
  assert(Number(p2.Costo_Promedio) === cmpAntesVenta, 'CMP intacto tras la venta');

  // ── 4. Impacto en caja (INGRESO por pago de factura) ──
  const movs = await prisma.movimientos_caja.findMany({
    where: { Origen_Tipo: 'factura', Origen_ID: facturaId }
  });
  assert(movs.length > 0, `Movimiento(s) INGRESO en caja por factura (= ${movs.length})`);
  const sumaIngreso = movs.reduce((a, m) => a + Number(m.Monto_USD), 0);
  assert(Math.abs(sumaIngreso - 17.4) < 0.01, `INGRESO en caja = 17.40 USD (= ${sumaIngreso.toFixed(2)})`);

  // ── 5. Exportación CSV del libro diario ──
  const csvRes = await fetch(`${BASE}/dashboard/exportar?periodo=mes&formato=csv`, { headers: auth });
  assert(csvRes.ok, `Exportación CSV (HTTP ${csvRes.status})`);
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  assert(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'CSV con BOM UTF-8 crudo (Excel)');
  const csv = new TextDecoder('utf-8').decode(csvBytes);
  assert(csv.includes('Tasa_BCV') && csv.includes('IGTF_USD') && csv.includes('Total_Bs'), 'Encabezados fiscales presentes');
  const filaProd = csv.split('\n').find((l) => l.startsWith(`${facturaId},`));
  assert(!!filaProd, 'Factura de prueba presente en el libro diario');
  assert(filaProd.includes('""') && filaProd.includes('Cliente ""Prueba""'), 'Escape RFC-4180 de comillas aplicado');
  assert(filaProd.includes(String(Number(tasa).toFixed(4))), `Tasa BCV histórica en la fila (${Number(tasa).toFixed(4)})`);

  const jsonRes = await (await fetch(`${BASE}/dashboard/exportar?periodo=mes&formato=json`, { headers: auth })).json();
  assert(jsonRes.totalRegistros >= 1, `Exportación JSON: ${jsonRes.totalRegistros} registros`);

  // ── 6. KPI de rentabilidad (% = margen / ventas × 100) ──
  const serie = await (await fetch(`${BASE}/dashboard/serie?periodo=mes`, { headers: auth })).json();
  const r = serie.rentabilidad;
  const esperado = serie.ventas.montoTotal > 0
    ? Number(((r.margenUsd / serie.ventas.montoTotal) * 100).toFixed(2)) : 0;
  assert(Math.abs(r.porcentaje - esperado) < 0.01,
    `Rentabilidad % = ${r.porcentaje}% (margen ${r.margenUsd} / ventas ${serie.ventas.montoTotal})`);
  // Venta de prueba: 15 base − costo 7.5 → margen 7.5; % global depende del período completo
  console.log(`INFO  Margen real global del período: ${r.porcentaje}% (costo ventas ${r.costoVentasUsd})`);

  // ── 7. Casos límite ──
  const badCliente = await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: 999999, Tasa_Cambio: tasa,
      detalles: [{ Producto_ID: prodId, Cantidad: 1, Precio_Unitario: 1 }]
    })
  });
  assert(badCliente.status >= 400 && badCliente.status < 500,
    `Cliente inexistente → HTTP ${badCliente.status} controlado`);

  const badStock = await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID, Tasa_Cambio: tasa,
      detalles: [{ Producto_ID: prodId, Cantidad: 9999, Precio_Unitario: 1 }]
    })
  });
  assert(badStock.status === 400, `Stock insuficiente → HTTP ${badStock.status} controlado`);

  // Producto con CMP=0 vendido sin entrada previa
  const prod2 = await (await fetch(`${BASE}/productos`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Nombre: 'Producto Costo Cero E2E', Precio_Venta: 3.0, Stock_Actual: 5,
      Stock_Minimo: 1, Costo_Promedio: 0, Categoria_ID: catId
    })
  })).json();
  const prod2Id = (prod2.producto ?? prod2).Producto_ID;
  const ventaCero = await (await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID, Tasa_Cambio: tasa,
      detalles: [{ Producto_ID: prod2Id, Cantidad: 1, Precio_Unitario: 3.0 }],
      Detalles_Pago: { pagoMovil: 3.48 }
    })
  })).json();
  assert(!!ventaCero.factura, `Venta con CMP=0 sin excepción (Factura ID ${ventaCero.factura?.Factura_ID})`);

  console.log('\n===========================================');
  console.log('PRUEBA DE HUMO E2E COMPLETADA SIN ERRORES');
  console.log('===========================================');
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
