/**
 * PRUEBA DE HUMO E2E — Ciclo comercial completo (Certificación)
 * Recepción de Stock → Recálculo CMP → Venta → Impacto en Caja → Exportación CSV
 * Ejecutar con el backend corriendo en :3000:  node scripts/smoke_e2e.js
 */
const { PrismaClient } = require('@prisma/client');
const guard = require('./qa_guard.cjs');
// Salvaguarda: el smoke toca la base de datos; jamás debe correr contra prod/remoto
// NI contra la base de DEMOSTRACIÓN `adrialga`. Este script crea notas de
// entrada, facturas y variantes de prueba; correrlo contra el catálogo que se
// presenta le inyecta residuos que luego se ven en pantalla (medido el
// 2026-10-14: 46 de los 100 productos activos eran residuos de E2E).
// Destino permitido: `adrialga_qa`. Escape explícito: ALLOW_SMOKE_EN_ADRIALGA=SI.
{
  const _smokeUrl = process.env.DATABASE_URL || '';
  const _smokeV = guard.validarHostLocal(_smokeUrl);
  if (!_smokeV.ok) {
    console.error(`ABORTADO: smoke_e2e.js requiere una base LOCAL (loopback). Destino: ${guard.sanitizar(_smokeUrl)} · ${_smokeV.error}`);
    process.exit(3);
  }
  let _smokeBase = '';
  try {
    _smokeBase = guard.rutaLimpia(new URL(guard.normalizarUrl(_smokeUrl)));
  } catch {
    /* base no reconocible: la validación de abajo la rechaza */
  }
  if (_smokeBase !== 'adrialga_qa' && process.env.ALLOW_SMOKE_EN_ADRIALGA !== 'SI') {
    console.error(
      `ABORTADO: smoke_e2e.js ESCRIBE datos de prueba y solo debe correr contra la base QA. ` +
        `Destino actual: '${_smokeBase || '?'}'. Si de verdad quieres ensuciar '${_smokeBase || '?'}', ` +
        `usa ALLOW_SMOKE_EN_ADRIALGA=SI.`
    );
    process.exit(3);
  }
}
const prisma = new PrismaClient();
const BASE = 'http://localhost:3000/api';

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

// ── Guardia de caja: el smoke NUNCA debe corromper la caja real ────────────
// Antes, la prueba manipulaba Saldo_Actual de la caja abierta (lo ponía en 0
// y luego en 100) y dejaba sus movimientos, descuadrando el arqueo real del
// usuario. Ahora se toma un snapshot (saldo + marca de Movimiento_ID) y se
// restaura/limpia TODO al final, incluso si la prueba falla. Si no hay caja
// abierta, se crea una temporal que se elimina al terminar.
let cajaSnapshot = null;   // { id, saldo, maxMovId }
let cajaTemporalId = null; // turno creado por el smoke (se elimina)

async function snapshotCaja() {
  const abierta = await prisma.caja.findFirst({ where: { Activa: true } });
  if (abierta) {
    const agg = await prisma.movimientos_caja.aggregate({
      where: { Caja_ID: abierta.Caja_ID },
      _max: { Movimiento_ID: true },
    });
    cajaSnapshot = {
      id: abierta.Caja_ID,
      saldo: Number(abierta.Saldo_Actual),
      maxMovId: agg._max.Movimiento_ID ?? 0,
    };
    console.log(`INFO  Caja real #${abierta.Caja_ID} detectada (saldo $${cajaSnapshot.saldo}). Se restaurará al final.`);
  } else {
    const creada = await prisma.caja.create({
      data: {
        Nombre: 'Caja Smoke E2E (temporal)',
        Saldo_Inicial: 0, Saldo_Actual: 0, Activa: true, Estado: 'ABIERTA',
      },
    });
    cajaTemporalId = creada.Caja_ID;
    console.log(`INFO  Sin caja abierta: se creó la temporal #${creada.Caja_ID} (se eliminará al final).`);
  }
}

async function restaurarCaja() {
  try {
    if (cajaTemporalId != null) {
      await prisma.movimientos_caja.deleteMany({ where: { Caja_ID: cajaTemporalId } });
      await prisma.caja.delete({ where: { Caja_ID: cajaTemporalId } });
      console.log(`INFO  Caja temporal #${cajaTemporalId} eliminada.`);
    } else if (cajaSnapshot) {
      // Borra SOLO los movimientos creados por el smoke (posteriores a la
      // marca) y devuelve el saldo original: la caja real queda intacta.
      const del = await prisma.movimientos_caja.deleteMany({
        where: {
          Caja_ID: cajaSnapshot.id,
          Movimiento_ID: { gt: cajaSnapshot.maxMovId },
        },
      });
      await prisma.caja.update({
        where: { Caja_ID: cajaSnapshot.id },
        data: { Saldo_Actual: cajaSnapshot.saldo },
      });
      console.log(
        `INFO  Caja real #${cajaSnapshot.id} restaurada (saldo $${cajaSnapshot.saldo}, ` +
        `${del.count} movimiento(s) del smoke eliminados).`
      );
    }
  } catch (e) {
    console.error('AVISO  No se pudo restaurar la caja:', e.message);
  }
}

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

  // Snapshot de la caja ANTES de tocar nada (se restaura en el finally).
  await snapshotCaja();

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
  const tasaRes = await (await fetch(`${BASE}/tasa-cambio`, { headers: auth })).json();
  const tasa = Number(tasaRes.tasa);
  assert(Number.isFinite(tasa) && tasa > 0,
    `Tasa BCV segura (finita y >0): ${tasa} (fuente: ${tasaRes.fuente ?? 'fallback'})`);

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
  // Bugfix ticket incompleto: el payload del POST debe venir hidratado
  // (detalle + productos + pagos + cliente) para la impresión inmediata.
  assert(Array.isArray(facRes.factura.detalle_facturas) && facRes.factura.detalle_facturas.length > 0,
    `Factura hidratada con ${facRes.factura.detalle_facturas.length} ítem(s)`);
  assert(!!facRes.factura.detalle_facturas[0].productos?.Nombre,
    `Ítem con nombre de producto: ${facRes.factura.detalle_facturas[0].productos?.Nombre}`);
  assert(!!facRes.factura.clientes?.Razon_Social && !!facRes.factura.usuarios?.Nombre,
    `Factura con cliente (${facRes.factura.clientes?.Razon_Social}) y cajero`);
  assert(Array.isArray(facRes.factura.pagos) && facRes.factura.pagos.length > 0,
    'Pagos incluidos en el payload de la factura');

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

  // ── 4b. Separación de canales (pago digital NO contamina la gaveta) ──
  // Venta 100% por Pago Móvil: el movimiento de caja se audita, pero
  // Saldo_Actual (efectivo físico) NO puede moverse ni un centavo.
  const saldoAntesDigital = Number((await prisma.caja.findFirst({ where: { Activa: true } })).Saldo_Actual);
  const facDigital = await (await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID,
      Detalles: [{ Producto_ID: prodId, Cantidad: 1, Precio_Unitario: 5 }],
      Tasa_Cambio: tasa,
      Detalles_Pago: { pagoMovil: 5.8 } // 5.00 USD base + 0.80 IVA 16%
    })
  })).json();
  assert(!!facDigital.factura, `Factura digital emitida (ID ${facDigital.factura?.Factura_ID})`);
  const saldoDespuesDigital = Number((await prisma.caja.findFirst({ where: { Activa: true } })).Saldo_Actual);
  assert(Math.abs(saldoDespuesDigital - saldoAntesDigital) < 0.000001,
    `Pago Móvil NO altera caja física (${saldoAntesDigital} → ${saldoDespuesDigital})`);
  // La auditoría sí debe dejar huella del pago en movimientos_caja:
  const movsDigital = await prisma.movimientos_caja.findMany({
    where: { Origen_Tipo: 'factura', Origen_ID: facDigital.factura.Factura_ID }
  });
  assert(movsDigital.length === 1,
    `Movimiento de auditoría del pago digital registrado (= ${movsDigital.length})`);
  // Limpieza: reversar la factura digital (NC sin egreso en efectivo) para
  // no contaminar el resto de la suite de pruebas.
  await fetch(`${BASE}/facturas/${facDigital.factura.Factura_ID}/reversar`, {
    method: 'POST', headers: auth, body: JSON.stringify({})
  });

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
  assert(filaProd.includes(String(Number(tasa).toFixed(4))) || filaProd.includes(String(Number(tasa).toFixed(3))), `Tasa BCV histórica en la fila (${Number(tasa).toFixed(4)})`);

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

  // ── 6b. Venta Matricial: Variante_ID descuenta stock de la variante ──
  const prodMatriz = await (await fetch(`${BASE}/productos`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Nombre: 'Lámpara Matriz E2E', Precio_Venta: 12.0, Stock_Actual: 4,
      Stock_Minimo: 1, Costo_Promedio: 8, Categoria_ID: catId
    })
  })).json();
  const prodMatrizId = (prodMatriz.producto ?? prodMatriz).Producto_ID;
  const bulkV = await fetch(`${BASE}/productos/${prodMatrizId}/variantes/bulk`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      variantes: [
        { sku: `MAT-${prodMatrizId}-GRIS`, atributos: { Color: 'Gris' }, stock: 3, costo: 8, precio: 12 },
        { sku: `MAT-${prodMatrizId}-AZUL`, atributos: { Color: 'Azul' }, stock: 1, costo: 8, precio: 12 }
      ]
    })
  });
  assert(bulkV.status === 201, `Variantes de matriz creadas (${bulkV.status})`);
  const matrizInfo = await (await fetch(`${BASE}/productos/${prodMatrizId}/variantes`, { headers: auth })).json();
  const gris = matrizInfo.matriz.find((v) => v.sku === `MAT-${prodMatrizId}-GRIS`);
  assert(!!gris, 'Variante Gris visible en el endpoint matriz');

  const facVariante = await (await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID, Tasa_Cambio: tasa,
      Detalles: [{ Producto_ID: prodMatrizId, Variante_ID: gris.varianteId, Cantidad: 2, Precio_Unitario: 12 }],
      Detalles_Pago: {}
    })
  })).json();
  assert(facVariante.factura, `Venta con Variante_ID (Factura ${facVariante.factura?.Factura_ID})`);
  const grisPost = (await (await fetch(`${BASE}/productos/${prodMatrizId}/variantes`, { headers: auth })).json())
    .matriz.find((v) => v.sku === `MAT-${prodMatrizId}-GRIS`);
  assert(grisPost.stock === 1, `Stock variante Gris: 3 → 1 tras la venta (= ${grisPost.stock})`);
  const padrePost = await prisma.productos.findUnique({ where: { Producto_ID: prodMatrizId } });
  assert(padrePost.Stock_Actual === 2, `Stock padre: 4 → 2 (= ${padrePost.Stock_Actual})`);
  const detV = facVariante.factura.detalle_facturas?.[0];
  assert(detV?.producto_variantes?.SKU_Variante === `MAT-${prodMatrizId}-GRIS`,
    `Ticket hidratado con SKU de variante (${detV?.producto_variantes?.SKU_Variante})`);
  assert(detV?.Costo_Unitario_Historico === 8 || Math.abs(detV?.Costo_Unitario_Historico - 8) < 0.0001,
    'CMP histórico usa el costo real de la variante (= 8)');
  // Reversa matricial: restituye ambos niveles
  await fetch(`${BASE}/facturas/${facVariante.factura.Factura_ID}/reversar`, {
    method: 'POST', headers: auth, body: JSON.stringify({})
  });
  const grisRev = (await (await fetch(`${BASE}/productos/${prodMatrizId}/variantes`, { headers: auth })).json())
    .matriz.find((v) => v.sku === `MAT-${prodMatrizId}-GRIS`);
  assert(grisRev.stock === 3, `Reversa restituye variante a 3 (= ${grisRev.stock})`);
  await fetch(`${BASE}/productos/${prodMatrizId}`, { method: 'DELETE', headers: auth });

  // Stock insuficiente a nivel variante → 400 controlado
  const badVariante = await fetch(`${BASE}/facturas`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID, Tasa_Cambio: tasa,
      Detalles: [{ Producto_ID: prodId, Cantidad: 99999, Precio_Unitario: 1 }]
    })
  });
  assert(badVariante.status === 400, `Stock variante insuficiente → 400 controlado`);

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

  // ── 8. Reversión de Venta (P0.4) — Nota de Crédito + stock/CMP + caja ──
  const ncSerie = new RegExp(/^NC-\d{4}-\d{8}$/);
  const cajaActiva = await prisma.caja.findFirst({ where: { Activa: true } });
  assert(!!cajaActiva, `Caja activa disponible para la reversión (ID ${cajaActiva?.Caja_ID})`);
  const saldoPrevio = Number(cajaActiva.Saldo_Actual);
  const stockPreReversion =
    (await prisma.productos.findUnique({ where: { Producto_ID: prodId } })).Stock_Actual;

  // 8a. Déficit de caja (saldo $0) → HTTP 400 SALDO_INSUFICIENTE + ROLLBACK ACID
  await prisma.caja.update({
    where: { Caja_ID: cajaActiva.Caja_ID },
    data: { Saldo_Actual: 0 }
  });
  const reversionDeficit = await fetch(`${BASE}/facturas/${facturaId}/reversar`, {
    method: 'POST', headers: auth, body: JSON.stringify({})
  });
  assert(reversionDeficit.status === 400,
    `Reversión con saldo $0 → HTTP ${reversionDeficit.status} (SALDO_INSUFICIENTE)`);
  const deficitBody = await reversionDeficit.json();
  assert(deficitBody.tipo === 'SALDO_INSUFICIENTE', `Body tipo=SALDO_INSUFICIENTE (${deficitBody.tipo})`);
  const factTrasDeficit = await prisma.facturas.findUnique({ where: { Factura_ID: facturaId } });
  assert(factTrasDeficit.Estatus === 'Pagada',
    `Rollback: la factura sigue "Pagada" tras rechazo (${factTrasDeficit.Estatus})`);
  const stockTrasDeficit =
    (await prisma.productos.findUnique({ where: { Producto_ID: prodId } })).Stock_Actual;
  assert(stockTrasDeficit === stockPreReversion,
    `Rollback: stock intacto tras rechazo (= ${stockTrasDeficit})`);
  // Financiar la gaveta para permitir la reversión real (garantiza y valida el caso).
  await prisma.caja.update({
    where: { Caja_ID: cajaActiva.Caja_ID },
    data: { Saldo_Actual: Math.max(saldoPrevio, 100) }
  });

  // 8b. Reversión real → NC + restitución de stock/CMP + egreso espejo en caja
  const revOk = await (await fetch(`${BASE}/facturas/${facturaId}/reversar`, {
    method: 'POST', headers: auth, body: JSON.stringify({})
  })).json();
  assert(!!revOk.notaCredito, `Reversión exitosa: Nota de Crédito ID ${revOk.notaCredito?.Factura_ID}`);
  // NC también hidratada (para su impresión): detalle + pagos + cliente.
  assert(Array.isArray(revOk.notaCredito.detalle_facturas) && revOk.notaCredito.detalle_facturas.length > 0,
    `NC hidratada con ${revOk.notaCredito.detalle_facturas.length} ítem(s)`);
  assert(!!revOk.notaCredito.clientes?.Razon_Social, 'NC con cliente incluido');
  const ncDb = await prisma.facturas.findUnique({
    where: { Factura_ID: revOk.notaCredito.Factura_ID }
  });
  assert(ncDb.Estatus === 'Emitida', `NC Estatus Emitida (${ncDb.Estatus})`);
  assert(ncDb.Tipo_Documento === 'NOTA_CREDITO', `NC Tipo_Documento NOTA_CREDITO (${ncDb.Tipo_Documento})`);
  assert(ncDb.Factura_Afectada_ID === facturaId, `NC afecta factura ${facturaId} (= ${ncDb.Factura_Afectada_ID})`);
  assert(ncSerie.test(ncDb.Numero_Control || ''), `NC serie CTRL-NC-<año>: ${ncDb.Numero_Control}`);
  assert(Number(ncDb.Total_General) < 0, `NC Total en negativo (-${Number(ncDb.Total_General).toFixed(2)})`);
  const factReversada = await prisma.facturas.findUnique({ where: { Factura_ID: facturaId } });
  assert(factReversada.Estatus === 'Reversada', `Original REVERSADA (${factReversada.Estatus})`);
  const pFinal = await prisma.productos.findUnique({ where: { Producto_ID: prodId } });
  assert(Number(pFinal.Stock_Actual) === 10, `Stock restituido a 10 (= ${Number(pFinal.Stock_Actual)})`);
  assert(Math.abs(Number(pFinal.Costo_Promedio) - 2.5) < 0.0001,
    `CMP recalculado a costo histórico 2.5000 (= ${Number(pFinal.Costo_Promedio)})`);
  const egresosRev = await prisma.movimientos_caja.findMany({
    where: { Origen_Tipo: 'factura', Origen_ID: facturaId, Tipo: 'EGRESO' }
  });
  assert(egresosRev.length > 0, `Egreso(s) en caja por reversión (= ${egresosRev.length})`);
  assert(Math.abs(Number(egresosRev[0].Monto_USD) - 17.4) < 0.01,
    `Egreso espejo = 17.40 USD (= ${Number(egresosRev[0].Monto_USD).toFixed(2)})`);

  console.log('\n===========================================');
  console.log('PRUEBA DE HUMO E2E COMPLETADA SIN ERRORES');
  console.log('===========================================');
})().catch((e) => {
  console.error('❌ ' + e.message);
  // exitCode (no process.exit) para que el `.finally` SÍ ejecute la
  // restauración de la caja incluso ante un fallo de la prueba.
  process.exitCode = 1;
})
  .finally(async () => {
    await restaurarCaja();
    await prisma.$disconnect();
  });
