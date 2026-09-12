// PRUEBA EXPERIMENTAL PARTE 1 — Lógica Financiera (Fondo de maniobra + anti-déficit).
// 1. Ingreso de caja exige PIN de supervisor (o rol).
// 2. Compra a contado con saldo insuficiente → 422 SALDO_INSUFICIENTE (se acabó el -$54).
// 3. Abono a CxP con insuficiencia → 422; ingreso de caja → abono exitoso.
const BASE = 'http://localhost:3000/api';
const { PrismaClient } = require('@prisma/client');
const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

(async () => {
  const prisma = new PrismaClient();
  const login = async (c, p) => {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Credencial: c, Password: p })
    });
    const { token } = await r.json();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  };

  // ── 0. Login admin + caja limpia (turno de hoy, saldo conocido) ──
  const admin = await login('admin', 'admin123');
  const hoy = new Date(); hoy.setUTCHours(0, 0, 0, 0);
  await prisma.caja.updateMany({ where: { Fecha_Apertura: { lt: hoy }, Activa: true }, data: { Activa: false, Estado: 'CERRADA', Fecha_Cierre: new Date() } });
  let turno = await prisma.caja.findFirst({ where: { Fecha_Apertura: { gte: hoy } }, orderBy: { Fecha_Apertura: 'desc' } });
  if (turno) {
    await prisma.caja.update({ where: { Caja_ID: turno.Caja_ID }, data: { Activa: true, Estado: 'ABIERTA', Fecha_Cierre: null, Saldo_Actual: 50, Saldo_Inicial: 50 } });
  } else {
    turno = await prisma.caja.create({ data: { Nombre: 'Caja Principal', Saldo_Inicial: 50, Saldo_Actual: 50, Activa: true, Estado: 'ABIERTA', Fecha_Apertura: new Date() } });
  }
  console.log(`INFO  Turno activo #${turno.Caja_ID} saldo $50`);

  // ── 1. Ingreso de caja SIN PIN como cajero → 401 PIN_INVALIDO ──
  // (El usuario admin es ADMIN: para probar el PIN necesitamos el flujo de cajero;
  //  el backend acepta rol ADMIN sin PIN. Verificamos el rechazo por PIN creando un
  //  usuario cajero si no existe.)
  let cajeroAuth = null;
  let cajero = await prisma.usuarios.findUnique({ where: { Credencial: 'cajero' } });
  if (!cajero) {
    // Hash directo con bcryptjs (mismo esquema que src/utils/password.util).
    const bcrypt = require('bcryptjs');
    cajero = await prisma.usuarios.create({
      data: {
        Credencial: 'cajero', Nombre: 'Cajero Prueba',
        Password: await bcrypt.hash('cajero123', 10),
        Rol: 'CAJERO', Activo: true
      }
    });
  }
  cajeroAuth = await login('cajero', 'cajero123');

  // 1a. Sin PIN → rechazado
  const rSinPin = await fetch(`${BASE}/caja/ingreso`, {
    method: 'POST', headers: cajeroAuth,
    body: JSON.stringify({ monto: 100 })
  });
  const sinPinBody = await rSinPin.json();
  assert(rSinPin.status === 401 && sinPinBody.tipo === 'PIN_INVALIDO',
    `Ingreso caja sin PIN rechazado (HTTP ${rSinPin.status}, tipo ${sinPinBody.tipo})`);

  // 1b. PIN incorrecto → rechazado
  const rPinMal = await fetch(`${BASE}/caja/ingreso`, {
    method: 'POST', headers: cajeroAuth,
    body: JSON.stringify({ monto: 100, pinSupervisor: '9999' })
  });
  assert(rPinMal.status === 401, `PIN incorrecto rechazado (HTTP ${rPinMal.status})`);

  // 1c. PIN correcto (bcrypt) como cajero → 201 y saldo +100
  const rPinOk = await fetch(`${BASE}/caja/ingreso`, {
    method: 'POST', headers: cajeroAuth,
    body: JSON.stringify({ monto: 100, pinSupervisor: '1234' })
  });
  assert(rPinOk.status === 201, `Ingreso de caja con PIN correcto → HTTP ${rPinOk.status}`);
  const trasIngreso = await prisma.caja.findUnique({ where: { Caja_ID: turno.Caja_ID } });
  assert(Number(trasIngreso.Saldo_Actual) === 150, `Saldo tras ingreso = $150 (= ${Number(trasIngreso.Saldo_Actual)})`);

  // ── 2. Compra a contado MAYOR al saldo → 422 SALDO_INSUFICIENTE ──
  // Necesitamos un producto barato y proveedor general. Total > saldo actual (150).
  const cat = await prisma.categorias.findFirst();
  let prod = await prisma.productos.findFirst({ where: { Nombre: { contains: 'ANTI-DEF' } } });
  if (!prod) {
    prod = await prisma.productos.create({ data: { SKU_Codigo: 'ANTIDEF-SALDO-1', Nombre: 'ANTI-DEF Test', Precio_Venta: 1, Costo_Promedio: 100, Stock_Actual: 5, Categoria_ID: cat.Categoria_ID } });
  }
  const notaRes = await fetch(`${BASE}/notas`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ Numero_Nota: `ND-ANTIDEF-${Date.now()}`, Forma_Pago: 'Contado', detalles: [{ Producto_ID: prod.Producto_ID, Cantidad: 10, Costo_Unitario: 100 }] })
  });
  const notaBody = await notaRes.json();
  assert(notaRes.status === 422 && notaBody.tipo === 'SALDO_INSUFICIENTE',
    `Compra contado sin fondos → HTTP ${notaRes.status}, tipo ${notaBody.tipo}`);
  const trasBloqueo = await prisma.caja.findUnique({ where: { Caja_ID: turno.Caja_ID } });
  assert(Number(trasBloqueo.Saldo_Actual) === 150, `Saldo intacto tras bloqueo (= ${Number(trasBloqueo.Saldo_Actual)})`);

  // ── 3. Abono a CxP: crear deuda a crédito, luego abono con insuficiencia y éxito ──
  const notaCred = await fetch(`${BASE}/notas`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ Numero_Nota: `ND-CXP-${Date.now()}`, Forma_Pago: 'Credito', detalles: [{ Producto_ID: prod.Producto_ID, Cantidad: 10, Costo_Unitario: 5 }] })
  });
  assert(notaCred.status === 201, `Nota a crédito registrada (HTTP ${notaCred.status})`);
  const cxp = await prisma.cuentas_por_pagar.findFirst({ orderBy: { CxP_ID: 'desc' } });
  assert(!!cxp && Number(cxp.Saldo) === 50, `CxP creada con saldo $50 (= ${Number(cxp?.Saldo)})`);

  // 3a. Abono mayor al saldo de caja (actualmente 150, abono de 1000) → 422
  const abonoMayor = await fetch(`${BASE}/tesoreria/cuentas-pagar/abonar`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ cxpId: cxp.CxP_ID, monto: 1000, metodoPago: 'Efectivo' })
  });
  const abonoMayorBody = await abonoMayor.json();
  assert(abonoMayor.status === 422 && abonoMayorBody.tipo === 'SALDO_INSUFICIENTE',
    `Abono sin fondos → HTTP ${abonoMayor.status}, tipo ${abonoMayorBody.tipo}`);

  // 3b. Abono que cabe en caja (#30) → éxito y saldo de deuda reducido
  const abonoOk = await fetch(`${BASE}/tesoreria/cuentas-pagar/abonar`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ cxpId: cxp.CxP_ID, monto: 30, metodoPago: 'Pago Móvil' })
  });
  const abonoOkBody = await abonoOk.json();
  assert(abonoOk.status === 200, `Abono de $30 → HTTP ${abonoOk.status}`);
  const cxpTras = await prisma.cuentas_por_pagar.findUnique({ where: { CxP_ID: cxp.CxP_ID } });
  assert(Number(cxpTras.Monto_Pagado) === 30 && Number(cxpTras.Saldo) === 20,
    `CxP tras abono: Pagado $30, Saldo $20 (= ${Number(cxpTras.Monto_Pagado)}/${Number(cxpTras.Saldo)})`);

  await prisma.$disconnect();
  console.log('\nLÓGICA FINANCIERA (FONDO MANIOBRA + ANTI-DÉFICIT): TODAS LAS PRUEBAS EN VERDE');
})().catch((e) => { console.log(`❌ ${e.message}`); process.exit(1); });