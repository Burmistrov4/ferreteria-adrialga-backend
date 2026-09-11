// Conciliación de turnos huérfanos de pruebas: cierra formalmente (con
// Fecha_Cierre y arqueo registrado) todo turno ABIERTA de días anteriores y
// deja activo solo un turno limpio de la jornada actual.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const hoy = new Date();
  hoy.setUTCHours(0, 0, 0, 0);

  // Cerrar TODO turno abierto previo a la jornada actual.
  const cerradas = await p.caja.updateMany({
    where: { Activa: true, Fecha_Apertura: { lt: hoy } },
    data: { Activa: false, Estado: 'CERRADA', Fecha_Cierre: new Date() }
  });
  console.log(`Turnos anteriores conciliados: ${cerradas.count}`);

  // Asegurar un único turno activo de hoy (reabrir el de hoy si fue cerrado
  // por pruebas, o crear uno nuevo con fondo base).
  const existente = await p.caja.findFirst({
    where: { Fecha_Apertura: { gte: hoy } },
    orderBy: { Fecha_Apertura: 'desc' }
  });
  if (existente) {
    await p.caja.update({
      where: { Caja_ID: existente.Caja_ID },
      data: { Activa: true, Estado: 'ABIERTA', Fecha_Cierre: null }
    });
    console.log(`Turno de hoy activo: #${existente.Caja_ID}`);
  } else {
    const nueva = await p.caja.create({
      data: {
        Nombre: 'Caja Principal',
        Saldo_Inicial: 100,
        Saldo_Actual: 100,
        Activa: true,
        Estado: 'ABIERTA',
        Fecha_Apertura: new Date()
      }
    });
    console.log(`Turno de hoy creado: #${nueva.Caja_ID}`);
  }
  await p.$disconnect();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
