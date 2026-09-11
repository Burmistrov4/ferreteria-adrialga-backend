// PRUEBA EXPERIMENTAL: bloqueo de facturación con arqueo pendiente (FRENTE 2).
// 1. Simula un turno de AYER abierto (sin Fecha_Cierre) directamente en BD.
// 2. Intenta vender → debe fallar HTTP 409 tipo ARQUEO_PENDIENTE.
// 3. Cierra el turno (arqueo) → la venta debe volver a fluir (o CAJA_CERRADA
//    si no hay turno de hoy, que es el comportamiento esperado).
// Ejecutar con el backend en :3000:  node scripts/test_arqueo_pendiente.cjs
const BASE = 'http://localhost:3000/api';
const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

(async () => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  // ── 0. Login ──
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  });
  const { token } = await loginRes.json();
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── 1. Preparación: cerrar cualquier turno activo actual y crear uno AYER ──
  await prisma.caja.updateMany({
    where: { Activa: true },
    data: { Activa: false, Estado: 'CERRADA', Fecha_Cierre: new Date() }
  });
  const ayer = new Date();
  ayer.setUTCHours(ayer.getUTCHours() - 24);
  const turnoHuerfano = await prisma.caja.create({
    data: {
      Nombre: 'Caja Principal',
      Saldo_Inicial: 50,
      Saldo_Actual: 50,
      Activa: true,
      Estado: 'ABIERTA',
      Fecha_Apertura: ayer // jornada anterior, sin Fecha_Cierre
    }
  });
  console.log(`INFO  Turno huérfano creado #${turnoHuerfano.Caja_ID} (apertura ${ayer.toISOString()})`);

  // ── 2. Producto barato para la venta de prueba ──
  const producto = await prisma.productos.findFirst({
    where: { Stock_Actual: { gt: 0 } }
  });
  const cliente = await prisma.clientes.findUnique({
    where: { RIF_Cedula: 'V-00000000' }
  });

  // ── 3. Intento de venta → DEBE bloquearse con ARQUEO_PENDIENTE ──
  const ventaRes = await fetch(`${BASE}/facturas`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID,
      detalles: [
        { Producto_ID: producto.Producto_ID, Cantidad: 1, Precio_Unitario: 1 }
      ],
      Tasa_Cambio: 100,
      Detalles_Pago: { efectivoVES: 200 }
    })
  });
  const ventaBody = await ventaRes.json();
  assert(
    ventaRes.status === 409 && ventaBody.tipo === 'ARQUEO_PENDIENTE',
    `Venta bloqueada con arqueo pendiente (HTTP ${ventaRes.status}, tipo ${ventaBody.tipo})`
  );
  assert(
    /turno #\d+/.test(ventaBody.error ?? ''),
    `Mensaje identifica el turno: ${String(ventaBody.error).slice(0, 80)}…`
  );

  // ── 4. Conciliar: arqueo del turno huérfano vía API de cierre ──
  const cierreRes = await fetch(`${BASE}/caja/cerrar`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ montoContado: 50 })
  });
  assert(cierreRes.ok, `Arqueo del turno pendiente ejecutado (HTTP ${cierreRes.status})`);

  // ── 5. Tras conciliar: la venta ya NO bloquea por arqueo (fallará con
  //      CAJA_CERRADA por no haber turno de hoy, o pasará si se abre caja) ──
  const venta2Res = await fetch(`${BASE}/facturas`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      Cliente_ID: cliente.Cliente_ID,
      detalles: [
        { Producto_ID: producto.Producto_ID, Cantidad: 1, Precio_Unitario: 1 }
      ],
      Tasa_Cambio: 100,
      Detalles_Pago: { efectivoVES: 200 }
    })
  });
  const venta2Body = await venta2Res.json();
  assert(
    venta2Body.tipo !== 'ARQUEO_PENDIENTE',
    `Bloqueo liberado tras arqueo (HTTP ${venta2Res.status}, tipo ${venta2Body.tipo ?? 'ok'})`
  );

  await prisma.$disconnect();
  console.log('\nARQUEO PENDIENTE: TODAS LAS PRUEBAS EN VERDE');
})().catch(async (e) => {
  console.log(`❌ ${e.message}`);
  const { PrismaClient } = require('@prisma/client');
  await new PrismaClient().$disconnect();
  process.exit(1);
});
