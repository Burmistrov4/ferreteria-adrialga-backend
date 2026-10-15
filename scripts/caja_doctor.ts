// scripts/caja_doctor.ts
// ─────────────────────────────────────────────────────────────────────────────
// CAJA DOCTOR — diagnóstico y mantenimiento del turno de caja (100% LOCALHOST)
//
// Responde a dos síntomas reportados:
//   "no puedo abrir la caja"  y  "el sistema dice que falta dinero".
//
// USO
//   npm run caja:doctor                      # diagnóstico (SOLO LECTURA)
//   npm run caja:doctor -- --limpiar-pruebas   # borra turnos de prueba (SEED/Smoke)
//   npm run caja:doctor -- --cerrar-huerfanos  # cierra turnos ABIERTOS de días previos
//
// REGLAS DE NEGOCIO QUE EXPLICA
//   * `abrirCaja` prohíbe abrir si ya hay un turno ABIERTO y si ya hubo un
//     turno HOY (regla "un turno por jornada"). Un turno del seed fechado HOY
//     bloquea la apertura real del cajero (409).
//   * El arqueo (`getHistoricoArqueos`) cuenta SOLO efectivo físico: los
//     cobros digitales (Pago Móvil, Punto, Zelle) van al banco y no a la gaveta.
//
// SEGURIDAD: rehúsa correr si DATABASE_URL no apunta a localhost (salvo --force).
// Las acciones destructivas SOLO tocan turnos marcados como de prueba.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { toD4, addD4, subD4, aDecimal } from '../src/utils/dinero';
import { esEfectivo } from '../src/utils/caja';

// ── Salvaguarda temprana (ADR-002/007): validar destino ANTES de instanciar Prisma.
// El escape --force ya existente sigue rigiendo (ver validarLocal más abajo).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _guardDoctor = require('./qa_guard.cjs');
{
  const _url = process.env.DATABASE_URL ?? '';
  const _v = _guardDoctor.validarHostLocal(_url);
  if (!_v.ok && !process.argv.includes('--force')) {
    console.error('✖ ABORTADO: DATABASE_URL no apunta a localhost. Usa --force si sabes lo que haces.');
    process.exit(1);
  }
}

const prisma = new PrismaClient();

// Marcas que identifican turnos generados por herramientas de prueba.
const MARCAS_PRUEBA = ['SEED-STRESS', 'temporal', 'Smoke', 'E2E'];

function esTurnoDePrueba(nombre: string): boolean {
  return MARCAS_PRUEBA.some((m) => nombre.includes(m));
}

function parseFlags(argv: string[]) {
  const has = (k: string) => argv.includes(`--${k}`);
  return {
    limpiarPruebas: has('limpiar-pruebas'),
    cerrarHuerfanos: has('cerrar-huerfanos'),
    force: has('force'),
  };
}

function validarLocal(force: boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const guard = require('./qa_guard.cjs');
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('✖ DATABASE_URL no definida. Revisa adrialga-backend/.env');
    process.exit(1);
  }
  // Rehúsa correr contra destinos remotos (fuente única qa_guard); --force anula.
  if (!guard.validarHostLocal(url).ok && !force) {
    console.error('✖ ABORTADO: DATABASE_URL no apunta a localhost. Usa --force si sabes lo que haces.');
    process.exit(1);
  }
}

const fmt = (d: Date | null): string =>
  d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—';

// `moneyD4` formatea un BigInt YA escalado a 4 decimales (D4); `money` un
// decimal crudo (string/number/Decimal). Confundirlos escalaba ×10000.
const moneyD4 = (d4: bigint): string => `$${Number(aDecimal(d4)).toFixed(2)}`;
const money = (v: unknown): string => moneyD4(toD4(v));

/** Arqueo de un turno cerrado con la fórmula CORREGIDA (solo efectivo). */
function arqueoDeTurno(movs: { Tipo: string; Concepto: string | null; Metodo_Pago: string | null; Monto_USD: unknown }[]) {
  let ingresosD4 = 0n;
  let egresosOpD4 = 0n;
  let entregadoD4 = 0n;
  for (const m of movs) {
    const montoD4 = toD4(m.Monto_USD);
    const concepto = (m.Concepto ?? '').trim();
    if (m.Tipo === 'INGRESO') {
      if (concepto.startsWith('Apertura de caja')) continue;
      if (!esEfectivo(m.Metodo_Pago)) continue;
      ingresosD4 = addD4(ingresosD4, montoD4);
    } else if (m.Tipo === 'EGRESO') {
      if (concepto.startsWith('Cierre de caja')) entregadoD4 = addD4(entregadoD4, montoD4);
      else if (esEfectivo(m.Metodo_Pago)) egresosOpD4 = addD4(egresosOpD4, montoD4);
    }
  }
  return { ingresosD4, egresosOpD4, entregadoD4 };
}

async function diagnostico(): Promise<void> {
  const turnos = await prisma.caja.findMany({
    include: { movimientos: true },
    orderBy: { Caja_ID: 'asc' },
  });

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  CAJA DOCTOR — DIAGNÓSTICO');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Turnos totales: ${turnos.length}\n`);

  const abiertos = turnos.filter((t) => t.Activa);
  const inicioHoy = new Date();
  inicioHoy.setUTCHours(0, 0, 0, 0);
  const deHoy = turnos.filter((t) => t.Fecha_Apertura >= inicioHoy);
  const prueba = turnos.filter((t) => esTurnoDePrueba(t.Nombre));

  // ── Bloqueadores de la apertura ──────────────────────────────────────────
  console.log('  ── Bloqueadores de "Abrir Caja" ──');
  if (abiertos.length === 0 && deHoy.length === 0) {
    console.log('  ✔ Ninguno. La caja se puede abrir.');
  } else {
    for (const t of abiertos) {
      const test = esTurnoDePrueba(t.Nombre) ? ' [PRUEBA]' : ' [REAL]';
      console.log(`  ✖ Turno ABIERTO #${t.Caja_ID} "${t.Nombre}"${test} — saldo ${money(t.Saldo_Actual)}. Bloquea abrir caja.`);
    }
    for (const t of deHoy) {
      if (t.Activa) continue;
      const test = esTurnoDePrueba(t.Nombre) ? ' [PRUEBA]' : ' [REAL]';
      console.log(`  ✖ Turno de HOY #${t.Caja_ID} "${t.Nombre}"${test} (${t.Estado}) — la regla "un turno por jornada" impide abrir otro hoy.`);
    }
  }

  // ── Turnos de prueba ─────────────────────────────────────────────────────
  console.log('\n  ── Turnos generados por pruebas ──');
  if (prueba.length === 0) {
    console.log('  ✔ Ninguno.');
  } else {
    console.log(`  ⚠ ${prueba.length} turno(s): ${prueba.map((t) => `#${t.Caja_ID}`).join(', ')}`);
    console.log('    Límpialos con:  npm run caja:doctor -- --limpiar-pruebas');
  }

  // ── Arqueos descuadrados (fórmula corregida) ─────────────────────────────
  console.log('\n  ── Arqueos del mes (solo efectivo) ──');
  let descuadres = 0;
  for (const t of turnos) {
    if (t.Estado !== 'CERRADA') continue;
    const { ingresosD4, egresosOpD4, entregadoD4 } = arqueoDeTurno(t.movimientos as any);
    const esperadoD4 = subD4(addD4(toD4(t.Saldo_Inicial), ingresosD4), egresosOpD4);
    const diffD4 = subD4(esperadoD4, entregadoD4);
    const diff = Number(aDecimal(diffD4));
    if (Math.abs(diff) > 0.01) {
      descuadres++;
      const etiqueta = diff > 0 ? `FALTA ${money(diff)}` : `SOBRA ${money(-diff)}`;
      console.log(`  • Turno #${t.Caja_ID} ${fmt(t.Fecha_Apertura)} — ${etiqueta} (esperado ${moneyD4(esperadoD4)}, entregado ${moneyD4(entregadoD4)})`);
    }
  }
  if (descuadres === 0) console.log('  ✔ Todos los turnos cerrados cuadran.');
  else console.log(`\n  ⚠ ${descuadres} turno(s) con diferencia. Los turnos ANTERIORES al fix de canal digital pueden mostrar sobrante residual (dato histórico).`);

  console.log('\n  Acciones disponibles:');
  console.log('    npm run caja:doctor -- --limpiar-pruebas    (borra turnos SEED/Smoke)');
  console.log('    npm run caja:doctor -- --cerrar-huerfanos   (cierra turnos ABIERTOS viejos)\n');
}

async function limpiarPruebas(): Promise<void> {
  console.log('\n🧹 Limpiando turnos de prueba (SEED-STRESS / Smoke / E2E)...\n');
  const prueba = (await prisma.caja.findMany()).filter((t) => esTurnoDePrueba(t.Nombre));
  if (prueba.length === 0) {
    console.log('  ✔ No hay turnos de prueba que borrar.\n');
    return;
  }
  const ids = prueba.map((t) => t.Caja_ID);
  await prisma.$transaction(async (tx) => {
    await tx.movimientos_caja.deleteMany({ where: { Caja_ID: { in: ids } } });
    await tx.caja.deleteMany({ where: { Caja_ID: { in: ids } } });
  });
  console.log(`  ✔ Eliminados ${ids.length} turno(s) de prueba y sus movimientos: ${ids.map((i) => `#${i}`).join(', ')}`);
  console.log('  La caja real NO fue tocada.\n');
}

async function cerrarHuerfanos(): Promise<void> {
  console.log('\n🔒 Cerrando turnos ABIERTOS de días anteriores (arqueo de regularización)...\n');
  const inicioHoy = new Date();
  inicioHoy.setUTCHours(0, 0, 0, 0);
  const huerfanos = await prisma.caja.findMany({
    where: { Activa: true, Fecha_Apertura: { lt: inicioHoy } },
  });
  if (huerfanos.length === 0) {
    console.log('  ✔ No hay turnos huérfanos.\n');
    return;
  }
  for (const t of huerfanos) {
    const saldoD4 = toD4(t.Saldo_Actual);
    await prisma.$transaction(async (tx) => {
      if (saldoD4 > 0n) {
        await tx.movimientos_caja.create({
          data: {
            Caja_ID: t.Caja_ID, Tipo: 'EGRESO',
            Concepto: 'Cierre de caja (arqueo): regularizado por caja_doctor',
            Metodo_Pago: 'Efectivo', Monto_USD: aDecimal(saldoD4),
            Origen_Tipo: 'manual', Fecha: new Date(),
          },
        });
      }
      await tx.caja.update({
        where: { Caja_ID: t.Caja_ID },
        data: { Activa: false, Estado: 'CERRADA', Fecha_Cierre: new Date(), Saldo_Actual: '0.0000' },
      });
    });
    console.log(`  ✔ Turno #${t.Caja_ID} cerrado (saldo entregado ${moneyD4(saldoD4)}).`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  validarLocal(flags.force);

  if (flags.limpiarPruebas) await limpiarPruebas();
  if (flags.cerrarHuerfanos) await cerrarHuerfanos();
  // El diagnóstico SIEMPRE se muestra al final (estado tras las acciones).
  await diagnostico();
}

main()
  .catch((e) => {
    console.error('\n✖ caja_doctor falló:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
