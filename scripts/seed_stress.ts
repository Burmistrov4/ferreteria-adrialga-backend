// scripts/seed_stress.ts
// ─────────────────────────────────────────────────────────────────────────────
// SEED DE ESTRES — Sistema Adrialga (FASE 4)
//
// Genera CIENTOS de movimientos financieros COHERENTES para certificar en
// LOCALHOST que:
//   1. El histórico de arqueos cuadra (sin doble conteo del fondo apertura).
//   2. La UI (Flutter) no congela con miles de filas en Caja/Tesoreria.
//   3. No hay desviaciones de centavos: TODO el dinero se acumula en BigInt D4.
//
// PRINCIPIOS DE DISENO
//   * 100% LOCAL: se rehusa a ejecutar si DATABASE_URL no apunta a localhost
//     (a menos que se pase --force). No toca ninguna configuracion de red.
//   * IDEMPOTENTE Y REVERSIBLE: cada fila creada queda marcada con la etiqueta
//     MARCA. `--reset` borra SOLO lo marcado; el resto de la BD no se toca.
//   * DETERMINISTA: PRNG propio (mulberry32) con semilla fija → dos corridas
//     con los mismos parametros producen exactamente los mismos datos.
//   * REPLICA EL LIBRO MAYOR REAL: cada movimiento imita lo que hace el
//     controlador (apertura/venta/compra/fondo/cierre) y mantiene
//     `caja.Saldo_Actual` sincronizado en D4, igual que la app.
//
// USO (ver README_SEED_STRESS.md):
//   npm run seed:stress                 # 45 dias x 12 ventas (default)
//   npm run seed:stress -- --dias=90 --ventas-dia=30
//   npm run seed:stress -- --reset      # borra solo los datos del seed
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { toD4, addD4, subD4, mulD4, divD4, aDecimal, IVA_ALIQUOTA, CIEN } from '../src/utils/dinero';
import { esEfectivo } from '../src/utils/caja';

// ── Salvaguarda temprana (ADR-002/007): validar destino ANTES de instanciar Prisma.
// El escape --force ya existente sigue rigiendo (ver validarEntornoLocal más abajo).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _guardSeed = require('./qa_guard.cjs');
{
  const _url = process.env.DATABASE_URL ?? '';
  const _v = _guardSeed.validarHostLocal(_url);
  if (!_v.ok && !process.argv.includes('--force')) {
    console.error(
      `✖ ABORTADO: destino de BD no permitido (${_guardSeed.sanitizar(_url)}): ${_v.error}\n` +
        '  Este seed es solo para entorno local. Usa --force si sabes lo que haces.',
    );
    process.exit(1);
  }
}

const prisma = new PrismaClient();

// ── Etiqueta que identifica TODO lo generado por este script ───────────────
const MARCA = 'SEED-STRESS';
const PREF_FACTURA = 'SEED-';
const PREF_NOTA = 'SEED-N';
const PREF_RIF_CLI = 'V-SEED';
const PREF_RIF_PROV = 'J-SEED';
const CREDENCIAL_CAJERO = `seed.cajero.${MARCA.toLowerCase()}`;
const NOMBRE_CAJA = `Caja Principal (${MARCA})`;

// ── PRNG determinista (mulberry32) ─────────────────────────────────────────
function mulberry32(semilla: number) {
  let a = semilla >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Argumentos CLI ─────────────────────────────────────────────────────────
interface Opciones {
  dias: number;
  ventasDia: number;
  comprasDia: number;
  semilla: number;
  reset: boolean;
  dejarAbierta: boolean;
  incluirHoy: boolean;
  force: boolean;
  fondoBase: string; // USD, 4 decimales
}

function parseArgs(argv: string[]): Opciones {
  const get = (k: string, def: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
  };
  const has = (k: string) => argv.includes(`--${k}`);
  return {
    dias: Math.max(1, Math.min(365, Number(get('dias', '45')) || 45)),
    ventasDia: Math.max(0, Math.min(200, Number(get('ventas-dia', '12')) || 12)),
    comprasDia: Math.max(0, Math.min(60, Number(get('compras-dia', '3')) || 3)),
    semilla: Number(get('semilla', '20260926')) || 20260926,
    reset: has('reset'),
    // Por defecto el seed CIERRA todos sus turnos y NO toca la jornada de HOY.
    // Dejar un turno ABIERTO o fechado hoy bloquea la apertura real del cajero
    // (regla "un turno por jornada" de abrirCaja → 409). Ambos comportamientos
    // son opt-in explícito para no volver a bloquear la caja del usuario.
    dejarAbierta: has('dejar-abierta'),
    incluirHoy: has('incluir-hoy'),
    force: has('force'),
    fondoBase: get('fondo', '60.0000'),
  };
}

// ── Guardia de seguridad: SOLO localhost (fuente única qa_guard) ───────────
function validarEntornoLocal(op: Opciones): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const guard = require('./qa_guard.cjs');
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('✖ DATABASE_URL no esta definida. Revisa adrialga-backend/.env');
    process.exit(1);
  }
  const v = guard.validarHostLocal(url);
  if (!v.ok && !op.force) {
    console.error(
      `✖ ABORTADO: destino de BD no permitido (${guard.sanitizar(url)}): ${v.error}\n` +
        `  Este seed es solo para entorno local. Usa --force si sabes lo que haces.`,
    );
    process.exit(1);
  }
  if (!v.ok && op.force) {
    console.warn('⚠ --force activo contra una BD remota. Continuando bajo tu responsabilidad.');
  }
}

// ── Utilidades de fecha (todo en UTC, como el backend) ─────────────────────
function utcMidnight(anio: number, mes: number, dia: number): Date {
  return new Date(Date.UTC(anio, mes, dia, 0, 0, 0, 0));
}
function conHora(base: Date, hora: number, minuto: number): Date {
  const d = new Date(base);
  d.setUTCHours(hora, minuto, 0, 0);
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET: borra unicamente lo que este script genero
// ═══════════════════════════════════════════════════════════════════════════
async function reset(): Promise<void> {
  console.log(`\n🧹 RESET — eliminando exclusivamente datos marcados "${MARCA}"...\n`);

  // Orden inverso a las FKs. Solo se toca lo marcado.
  const facturas = await prisma.facturas.findMany({
    where: { Numero_Control: { startsWith: PREF_FACTURA } },
    select: { Factura_ID: true },
  });
  const idsFacturas = facturas.map((f) => f.Factura_ID);

  const notas = await prisma.notas_entrega_entrada.findMany({
    where: { Numero_Nota: { startsWith: PREF_NOTA } },
    select: { Nota_ID: true },
  });
  const idsNotas = notas.map((n) => n.Nota_ID);

  const cajas = await prisma.caja.findMany({
    where: { Nombre: NOMBRE_CAJA },
    select: { Caja_ID: true },
  });
  const idsCajas = cajas.map((c) => c.Caja_ID);

  await prisma.$transaction(async (tx) => {
    if (idsFacturas.length) {
      await tx.pagos.deleteMany({ where: { Factura_ID: { in: idsFacturas } } });
      await tx.detalle_facturas.deleteMany({ where: { Factura_ID: { in: idsFacturas } } });
    }
    if (idsNotas.length) {
      await tx.cuentas_por_pagar.deleteMany({ where: { Nota_ID: { in: idsNotas } } });
      await tx.detalle_notas_entrega.deleteMany({ where: { Nota_ID: { in: idsNotas } } });
    }
    await tx.facturas.deleteMany({ where: { Numero_Control: { startsWith: PREF_FACTURA } } });
    await tx.notas_entrega_entrada.deleteMany({ where: { Numero_Nota: { startsWith: PREF_NOTA } } });

    if (idsCajas.length) {
      await tx.movimientos_caja.deleteMany({ where: { Caja_ID: { in: idsCajas } } });
      await tx.caja.deleteMany({ where: { Caja_ID: { in: idsCajas } } });
    }

    await tx.clientes.deleteMany({ where: { RIF_Cedula: { startsWith: PREF_RIF_CLI } } });
    await tx.proveedores.deleteMany({ where: { RIF_Cedula: { startsWith: PREF_RIF_PROV } } });
    await tx.tasas_bcv.deleteMany({ where: { Origen: MARCA } });
    await tx.usuarios.deleteMany({ where: { Credencial: CREDENCIAL_CAJERO } });
  });

  console.log(
    `✔ Reset completado: ${idsFacturas.length} facturas, ${idsNotas.length} notas, ` +
      `${idsCajas.length} turnos de caja, y sus movimientos asociados.\n` +
      `  El resto de la base de datos NO fue modificado.\n`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SEMILLA BASE: catalogo minimo para que las ventas/compras sean validas
// ═══════════════════════════════════════════════════════════════════════════
interface Catalogo {
  cajeroId: number;
  clienteIds: number[];
  proveedorId: number;
  productos: { id: number; precioD4: bigint; costoD4: bigint; nombre: string }[];
}

async function asegurarCatalogo(rng: () => number): Promise<Catalogo> {
  // ── Usuario cajero (marcado) ────────────────────────────────────────────
  // `Credencial` es @unique: se usa upsert (no findUnique + create) para que
  // una corrida concurrente o un reintento no pueda lanzar P2002.
  const cajero = await prisma.usuarios.upsert({
    where: { Credencial: CREDENCIAL_CAJERO },
    update: {},
    create: {
      Nombre: 'Cajero de Pruebas (SEED)',
      Credencial: CREDENCIAL_CAJERO,
      // bcrypt de "seed1234" — solo para entorno local de pruebas.
      Password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
      Rol: 'CAJERO',
      Activo: true,
    },
  });

  // ── Categorias (se reutilizan las existentes si ya hay) ─────────────────
  const categorias = await prisma.categorias.findMany({ take: 4 });
  let categoriaId: number;
  if (categorias.length === 0) {
    const creada = await prisma.categorias.create({
      data: { Nombre: 'Ferreteria (SEED)', Prefijo_SKU: 'FER', Margen_Sugerido: '30.0000' },
    });
    categoriaId = creada.Categoria_ID;
  } else {
    categoriaId = categorias[0].Categoria_ID;
  }

  // ── Clientes (marcados) ─────────────────────────────────────────────────
  // BUGFIX: la rama "else" NO agregaba los clientes ya existentes, asi que
  // tras una corrida parcial las ventas se concentraban en un unico cliente.
  // Ademas el RIF se deriva del maximo sufijo (no del count) para no
  // reutilizar un RIF vivo si se borraron filas intermedias.
  const clienteIds: number[] = [];
  const existentesCli = await prisma.clientes.findMany({
    where: { RIF_Cedula: { startsWith: PREF_RIF_CLI } },
    select: { Cliente_ID: true, RIF_Cedula: true },
  });
  clienteIds.push(...existentesCli.map((c) => c.Cliente_ID));
  let sufijoCli = existentesCli.reduce((max, c) => {
    const n = Number(c.RIF_Cedula.slice(PREF_RIF_CLI.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  while (clienteIds.length < 25) {
    sufijoCli += 1;
    const rif = `${PREF_RIF_CLI}${String(sufijoCli).padStart(6, '0')}`;
    const creado = await prisma.clientes.upsert({
      where: { RIF_Cedula: rif },
      update: {},
      create: {
        RIF_Cedula: rif,
        Tipo_Documento: 'V',
        Num_Documento: String(sufijoCli).padStart(8, '0'),
        Razon_Social: `Cliente SEED ${sufijoCli}`,
        Direccion: 'Direccion de prueba (seed)',
        Telefono: '04140000000',
      },
    });
    clienteIds.push(creado.Cliente_ID);
  }

  // ── Proveedor (marcado) ─────────────────────────────────────────────────
  const rifProv = `${PREF_RIF_PROV}000001`;
  const proveedor = await prisma.proveedores.upsert({
    where: { RIF_Cedula: rifProv },
    update: {},
    create: {
      RIF_Cedula: rifProv,
      Razon_Social: 'Proveedor SEED (Pruebas)',
      Telefono: '02120000000',
      Activo: true,
    },
  });

  // ── Productos: se reutilizan los existentes; si faltan, se crean 40 ─────
  let productosRaw = await prisma.productos.findMany({ take: 40, where: { Activo: true } });
  if (productosRaw.length < 12) {
    const faltan = 40 - productosRaw.length;
    for (let i = 0; i < faltan; i++) {
      const sku = `SEED-FER-${String(i + 1).padStart(4, '0')}`;
      const costoD4 = toD4((1 + Math.floor(rng() * 40)) + Math.floor(rng() * 99) / 100);
      const precioD4 = mulD4(costoD4, addD4(CIEN, toD4('30'))); // +30% margen
      await prisma.productos.upsert({
        where: { SKU_Codigo: sku },
        update: {},
        create: {
          SKU_Codigo: sku,
          Nombre: `Producto SEED ${i + 1}`,
          Precio_Venta: aDecimal(precioD4),
          Costo_Promedio: aDecimal(costoD4),
          Costo_Ultimo: aDecimal(costoD4),
          Margen_Ganancia: '30.0000',
          Stock_Actual: 100000, // stock simbolico: el seed no valida inventario
          Stock_Minimo: 5,
          Categoria_ID: categoriaId,
          Activo: true,
        },
      });
    }
    productosRaw = await prisma.productos.findMany({ take: 40, where: { Activo: true } });
  }

  const productos = productosRaw.map((p) => ({
    id: p.Producto_ID,
    precioD4: toD4(p.Precio_Venta),
    costoD4: toD4(p.Costo_Ultimo ?? p.Costo_Promedio),
    nombre: p.Nombre,
  }));

  return { cajeroId: cajero.Usuario_ID, clienteIds, proveedorId: proveedor.Proveedor_ID, productos };
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERACION DE LA JORNADA SIMULADA
// ═══════════════════════════════════════════════════════════════════════════
interface Totales {
  facturas: number;
  renglones: number;
  pagos: number;
  notas: number;
  movimientos: number;
  turnos: number;
}

async function seed(): Promise<void> {
  const op = parseArgs(process.argv.slice(2));
  validarEntornoLocal(op);

  if (op.reset) {
    await reset();
    return;
  }

  const rng = mulberry32(op.semilla);
  const fondoD4 = toD4(op.fondoBase);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SEED DE ESTRES — Sistema Adrialga (100% LOCALHOST)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Dias simulados ....... ${op.dias}`);
  console.log(`  Ventas por dia ....... ${op.ventasDia}`);
  console.log(`  Compras por dia ...... ${op.comprasDia}`);
  console.log(`  Fondo de apertura .... $${aDecimal(fondoD4)}`);
  console.log(`  Semilla PRNG ......... ${op.semilla} (determinista)`);
  console.log(`  Turno final .......... ${op.dejarAbierta ? 'queda ABIERTA' : 'se cierra'}`);
  console.log(`  Jornada de hoy ....... ${op.incluirHoy ? 'INCLUIDA (--incluir-hoy)' : 'excluida (no bloquea la apertura real)'}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── Guardia 1: no pisar un turno real abierto por la aplicacion ──────────
  // La app exige un unico turno ABIERTA. Si el usuario ya abrio caja hoy,
  // inyectar otro turno romperia esa regla de negocio. Se aborta (o se
  // cierra el turno previo del propio seed, que si es nuestro).
  const abiertas = await prisma.caja.findMany({ where: { Activa: true } });
  for (const a of abiertas) {
    if (a.Nombre === NOMBRE_CAJA) {
      // Turno abierto de una corrida anterior del seed: se cierra limpiamente.
      const saldoPrevD4 = toD4(a.Saldo_Actual);
      if (saldoPrevD4 > 0n) {
        await prisma.movimientos_caja.create({
          data: {
            Caja_ID: a.Caja_ID, Tipo: 'EGRESO', Concepto: 'Cierre de caja (arqueo)',
            Metodo_Pago: 'Efectivo', Monto_USD: aDecimal(saldoPrevD4),
            Referencia: MARCA, Origen_Tipo: 'manual', Fecha: new Date(),
          },
        });
      }
      await prisma.caja.update({
        where: { Caja_ID: a.Caja_ID },
        data: { Activa: false, Estado: 'CERRADA', Fecha_Cierre: new Date(), Saldo_Actual: '0.0000' },
      });
      console.log(`  ↻ Turno previo del seed (#${a.Caja_ID}) cerrado antes de iniciar.`);
    } else if (!op.force) {
      console.error(
        `✖ ABORTADO: ya existe un turno de caja ABIERTO ajeno al seed (#${a.Caja_ID}, "${a.Nombre}").\n` +
          `  Ciérralo desde la aplicación o ejecuta con --force.\n` +
          `  (El seed no toca turnos reales: solo borra lo marcado ${MARCA} con --reset.)`,
      );
      return;
    }
  }

  const cat = await asegurarCatalogo(rng);
  const totales: Totales = {
    facturas: 0, renglones: 0, pagos: 0, notas: 0, movimientos: 0, turnos: 0,
  };
  // Turnos creados en ESTA corrida: la verificación de integridad valida solo
  // estos (no el histórico, que puede tener datos de versiones anteriores).
  const idsTurnosCreados: number[] = [];

  // Tasa BCV: parte de 36.50 y deriva con jitter diario (nunca negativa).
  let tasaD4 = toD4('36.5000');

  const hoy = new Date();
  // ── Contadores correlativos IDEMPOTENTES ─────────────────────────────────
  // BUGFIX (P2002): antes se inicializaban en 0, asi que la 2ª ejecución sin
  // `--reset` intentaba recrear SEED-0000001 y Prisma lanzaba
  // "Unique constraint failed on the fields: (`Numero_Control`)".
  //
  // Se arranca desde el MAYOR sufijo numérico ya presente, NO desde el
  // `count()`: si alguien borra una fila intermedia a mano, count=69 con
  // max=70 volvería a generar SEED-0000070 y colisionaría otra vez. El
  // máximo es la única base realmente segura.
  const maxSufijo = (valores: (string | null)[], prefijo: string): number => {
    let max = 0;
    for (const v of valores) {
      if (!v || !v.startsWith(prefijo)) continue;
      const n = Number(v.slice(prefijo.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  };

  const facturasSeed = await prisma.facturas.findMany({
    where: { Numero_Control: { startsWith: PREF_FACTURA } },
    select: { Numero_Control: true },
  });
  let contadorFactura = maxSufijo(
    facturasSeed.map((f) => f.Numero_Control),
    PREF_FACTURA,
  );

  const notasSeed = await prisma.notas_entrega_entrada.findMany({
    where: { Numero_Nota: { startsWith: PREF_NOTA } },
    select: { Numero_Nota: true },
  });
  let contadorNota = maxSufijo(
    notasSeed.map((n) => n.Numero_Nota),
    PREF_NOTA,
  );

  if (contadorFactura > 0 || contadorNota > 0) {
    console.log(
      `  Reanudando sin reset: ya existen ${contadorFactura} factura(s) y ` +
        `${contadorNota} nota(s) del seed. Los correlativos continúan desde ahí.`,
    );
  }

  let diasOmitidos = 0;

  // ── Rango de días: por defecto NO se toca la jornada de HOY ──────────────
  // El sistema impone "un turno por jornada" (ver abrirCaja): un turno del
  // seed fechado HOY bloquearía la apertura real del cajero (409 "ya se
  // registró una apertura hoy"). Por eso el rango por defecto es
  // [hoy - dias, hoy - 1]; solo con --incluir-hoy se simula la jornada actual.
  const dInicio = op.incluirHoy ? op.dias - 1 : op.dias;
  const dFin = op.incluirHoy ? 0 : 1;

  for (let d = dInicio; d >= dFin; d--) {
    const fecha = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - d));
    const esUltimoDia = d === dFin;

    // ── Guardia 2: respetar la regla "un turno por jornada" ────────────────
    // Si YA existe un turno real en esa fecha (creado desde la app), no se
    // inyecta otro: se omite el dia y se reporta.
    const inicio = utcMidnight(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());
    const fin = new Date(inicio.getTime() + 86400000);
    const turnoExistente = await prisma.caja.findFirst({
      where: { Fecha_Apertura: { gte: inicio, lt: fin } },
      select: { Caja_ID: true, Nombre: true },
    });
    if (turnoExistente) {
      diasOmitidos++;
      continue;
    }

    // ── 1) Tasa de cambio del dia (serie historica coherente) ────────────
    const deriva = toD4((rng() * 0.35 - 0.12).toFixed(4)); // -0.12% .. +0.23% diario
    tasaD4 = addD4(tasaD4, mulD4(tasaD4, divD4(deriva, CIEN)));
    if (tasaD4 < toD4('20')) tasaD4 = toD4('20'); // piso de seguridad: sin NaN, sin negativos

    // BUGFIX (perdida de datos reales): el upsert incondicional sobrescribia
    // la tasa REAL de esa fecha (publicada por el microservicio scraper) y
    // dejaba Origen = SEED-STRESS; un `--reset` posterior la borraba para
    // siempre. Ahora solo se escribe si la fila no existe o ya es nuestra.
    const fechaTasa = utcMidnight(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());
    const tasaPrev = await prisma.tasas_bcv.findUnique({ where: { Fecha: fechaTasa } });
    if (!tasaPrev || tasaPrev.Origen === MARCA) {
      await prisma.tasas_bcv.upsert({
        where: { Fecha: fechaTasa },
        update: { Tasa: aDecimal(tasaD4), Origen: MARCA },
        create: { Fecha: fechaTasa, Tasa: aDecimal(tasaD4), Origen: MARCA },
      });
    }

    // ── 2) APERTURA DEL TURNO ────────────────────────────────────────────
    // Igual que `abrirCaja`: Saldo_Inicial = Saldo_Actual = fondo, y se
    // registra un INGRESO "Apertura de caja" que NO incrementa Saldo_Actual.
    const apertura = conHora(fecha, 8, 0);
    const turno = await prisma.caja.create({
      data: {
        Nombre: NOMBRE_CAJA,
        Saldo_Inicial: aDecimal(fondoD4),
        Saldo_Actual: aDecimal(fondoD4),
        Estado: 'ABIERTA',
        Fecha_Apertura: apertura,
        Activa: true,
      },
    });
    totales.turnos++;
    idsTurnosCreados.push(turno.Caja_ID);

    let saldoD4 = fondoD4; // espejo exacto de caja.Saldo_Actual, en BigInt

    const movimientosDelDia: {
      Caja_ID: number; Tipo: string; Concepto: string; Metodo_Pago: string;
      Monto_USD: string; Tasa_Cambio: string | null; Referencia: string | null;
      Origen_ID: number | null; Origen_Tipo: string | null; Fecha: Date;
    }[] = [];

    movimientosDelDia.push({
      Caja_ID: turno.Caja_ID, Tipo: 'INGRESO', Concepto: 'Apertura de caja',
      Metodo_Pago: 'Efectivo', Monto_USD: aDecimal(fondoD4),
      Tasa_Cambio: aDecimal(tasaD4), Referencia: MARCA,
      Origen_ID: null, Origen_Tipo: 'manual', Fecha: apertura,
    });

    // ── 3) VENTAS del dia ────────────────────────────────────────────────
    let minutoCursor = 30; // primera venta a las 08:30
    for (let v = 0; v < op.ventasDia; v++) {
      const clienteId = cat.clienteIds[Math.floor(rng() * cat.clienteIds.length)];
      const renglones = 1 + Math.floor(rng() * 4); // 1..4 productos por factura

      let subtotalD4 = 0n;
      const detalle: { productoId: number; cantidad: number; precioD4: bigint; costoD4: bigint }[] = [];
      for (let r = 0; r < renglones; r++) {
        const prod = cat.productos[Math.floor(rng() * cat.productos.length)];
        const cantidad = 1 + Math.floor(rng() * 5);
        subtotalD4 = addD4(subtotalD4, mulD4(prod.precioD4, toD4(cantidad)));
        detalle.push({ productoId: prod.id, cantidad, precioD4: prod.precioD4, costoD4: prod.costoD4 });
      }

      // IVA 16% sobre el subtotal (motor D4: sin floats, sin deriva).
      const ivaD4 = divD4(mulD4(subtotalD4, IVA_ALIQUOTA), CIEN);
      // IGTF 3% solo si una parte se paga en divisas (30% de las ventas).
      const pagaDivisa = rng() < 0.3;
      const montoDivisaD4 = pagaDivisa
        ? divD4(mulD4(addD4(subtotalD4, ivaD4), toD4('60')), CIEN) // 60% en USD
        : 0n;
      const igtfD4 = pagaDivisa
        ? divD4(mulD4(montoDivisaD4, toD4('3')), CIEN)
        : 0n;
      const totalD4 = addD4(addD4(subtotalD4, ivaD4), igtfD4);

      contadorFactura++;
      const numeroControl = `${PREF_FACTURA}${String(contadorFactura).padStart(7, '0')}`;
      const fechaVenta = conHora(fecha, 8 + Math.floor(minutoCursor / 60), minutoCursor % 60);
      minutoCursor += 12 + Math.floor(rng() * 25); // separa las ventas en el dia
      if (minutoCursor > 16 * 60) minutoCursor = 30; // rebobina si nos pasamos del cierre

      const factura = await prisma.facturas.create({
        data: {
          Numero_Control: numeroControl,
          Fecha_Emision: fechaVenta,
          Subtotal: aDecimal(subtotalD4),
          Total_IVA: aDecimal(ivaD4),
          Total_General: aDecimal(totalD4),
          Monto_IGTF: aDecimal(igtfD4),
          Tasa_Cambio: aDecimal(tasaD4),
          Estatus: 'Completada',
          Tipo_Documento: 'FACTURA',
          Cliente_ID: clienteId,
          Usuario_ID: cat.cajeroId,
        },
      });
      totales.facturas++;

      await prisma.detalle_facturas.createMany({
        data: detalle.map((d) => ({
          Factura_ID: factura.Factura_ID,
          Producto_ID: d.productoId,
          Cantidad: d.cantidad,
          Precio_Unitario: aDecimal(d.precioD4),
          Costo_Unitario_Historico: aDecimal(d.costoD4),
          Subtotal: aDecimal(mulD4(d.precioD4, toD4(d.cantidad))),
        })),
      });
      totales.renglones += detalle.length;

      await prisma.pagos.create({
        data: {
          Factura_ID: factura.Factura_ID,
          Metodo_Pago: pagaDivisa ? 'Mixto' : 'Efectivo',
          Monto: aDecimal(totalD4),
          Referencia: MARCA,
          Es_Divisa: pagaDivisa,
          Tasa_Cambio: aDecimal(tasaD4),
          Fecha_Pago: fechaVenta,
        },
      });
      totales.pagos++;

      // Movimiento de caja + incremento de Saldo_Actual (como el controlador).
      saldoD4 = addD4(saldoD4, totalD4);
      movimientosDelDia.push({
        Caja_ID: turno.Caja_ID, Tipo: 'INGRESO',
        Concepto: `Cobro factura #${factura.Factura_ID} (${numeroControl})`,
        // Canal: el seed usa SIEMPRE métodos EFECTIVO para que el arqueo (que
        // solo cuenta efectivo físico) cuadre con Saldo_Actual. Un método
        // digital —o "Mixto", que no es efectivo— haría que el arqueo excluyera
        // ese ingreso mientras el saldo sí lo sumó → descuadre artificial en la
        // autoverificación de integridad.
        Metodo_Pago: pagaDivisa ? 'Efectivo USD' : 'Efectivo',
        Monto_USD: aDecimal(totalD4),
        Tasa_Cambio: aDecimal(tasaD4), Referencia: MARCA,
        Origen_ID: factura.Factura_ID, Origen_Tipo: 'factura', Fecha: fechaVenta,
      });
    }

    // ── 4) COMPRAS del dia (contado descuenta caja / credito genera CxP) ──
    for (let c = 0; c < op.comprasDia; c++) {
      const renglones = 1 + Math.floor(rng() * 3);
      let totalCostoD4 = 0n;
      const detalle: { productoId: number; cantidad: number; costoD4: bigint }[] = [];
      for (let r = 0; r < renglones; r++) {
        const prod = cat.productos[Math.floor(rng() * cat.productos.length)];
        const cantidad = 5 + Math.floor(rng() * 40);
        totalCostoD4 = addD4(totalCostoD4, mulD4(prod.costoD4, toD4(cantidad)));
        detalle.push({ productoId: prod.id, cantidad, costoD4: prod.costoD4 });
      }

      contadorNota++;
      const numeroNota = `${PREF_NOTA}${String(contadorNota).padStart(7, '0')}`;
      const fechaCompra = conHora(fecha, 12 + Math.floor(rng() * 5), Math.floor(rng() * 59));
      const esCredito = rng() < 0.5;

      const nota = await prisma.notas_entrega_entrada.create({
        data: {
          Numero_Nota: numeroNota,
          Fecha_Recepcion: fechaCompra,
          Total_Costo: aDecimal(totalCostoD4),
          Estatus: 'Procesada',
          Proveedor_ID: cat.proveedorId,
          Usuario_ID: cat.cajeroId,
        },
      });
      totales.notas++;

      await prisma.detalle_notas_entrega.createMany({
        data: detalle.map((d) => ({
          Nota_ID: nota.Nota_ID,
          Producto_ID: d.productoId,
          Cantidad: d.cantidad,
          Costo_Unitario: aDecimal(d.costoD4),
          Subtotal_Costo: aDecimal(mulD4(d.costoD4, toD4(d.cantidad))),
        })),
      });

      if (esCredito) {
        await prisma.cuentas_por_pagar.create({
          data: {
            Proveedor_ID: cat.proveedorId,
            Nota_ID: nota.Nota_ID,
            Monto_Total: aDecimal(totalCostoD4),
            Monto_Pagado: '0.0000',
            Saldo: aDecimal(totalCostoD4),
            Fecha: fechaCompra,
            Vencimiento: new Date(fechaCompra.getTime() + 30 * 86400000),
            Estatus: 'Pendiente',
          },
        });
        // Credito: NO toca caja. Sin movimiento, sin descuento de saldo.
      } else {
        // Contado: EGRESO de caja y decremento de Saldo_Actual.
        saldoD4 = subD4(saldoD4, totalCostoD4);
        movimientosDelDia.push({
          Caja_ID: turno.Caja_ID, Tipo: 'EGRESO',
          Concepto: `Pago nota de entrega #${nota.Nota_ID} (${numeroNota})`,
          Metodo_Pago: 'Efectivo',
          Monto_USD: aDecimal(totalCostoD4),
          Tasa_Cambio: aDecimal(tasaD4), Referencia: MARCA,
          Origen_ID: nota.Nota_ID, Origen_Tipo: 'nota', Fecha: fechaCompra,
        });
      }
    }

    // ── 5) FONDO DE MANIOBRA ocasional (20% de los dias) ─────────────────
    if (rng() < 0.2) {
      const fondoExtraD4 = mulD4(fondoD4, toD4('0.5')); // 50% del fondo base
      saldoD4 = addD4(saldoD4, fondoExtraD4);
      movimientosDelDia.push({
        Caja_ID: turno.Caja_ID, Tipo: 'INGRESO',
        Concepto: 'Ingreso de caja (fondo de maniobra)',
        Metodo_Pago: 'Efectivo',
        Monto_USD: aDecimal(fondoExtraD4),
        Tasa_Cambio: aDecimal(tasaD4), Referencia: MARCA,
        Origen_ID: null, Origen_Tipo: 'manual',
        Fecha: conHora(fecha, 14, 30),
      });
    }

    // ── 6) CIERRE DEL TURNO (excepto el ultimo dia si --dejar-abierta) ────
    const cerrarTurno = !esUltimoDia || !op.dejarAbierta;
    if (cerrarTurno) {
      if (saldoD4 > 0n) {
        movimientosDelDia.push({
          Caja_ID: turno.Caja_ID, Tipo: 'EGRESO',
          // El prefijo "Cierre de caja" es el que el histórico interpreta
          // como saldo ENTREGADO (no como egreso operativo). Respetarlo es
          // obligatorio para que el arqueo cuadre.
          Concepto: 'Cierre de caja (arqueo)',
          Metodo_Pago: 'Efectivo',
          Monto_USD: aDecimal(saldoD4),
          Tasa_Cambio: aDecimal(tasaD4), Referencia: MARCA,
          Origen_ID: null, Origen_Tipo: 'manual',
          Fecha: conHora(fecha, 17, 45),
        });
      }
    }

    // Persistir movimientos y actualizar el turno en UNA transaccion.
    await prisma.$transaction(async (tx) => {
      await tx.movimientos_caja.createMany({ data: movimientosDelDia });
      totales.movimientos += movimientosDelDia.length;
      await tx.caja.update({
        where: { Caja_ID: turno.Caja_ID },
        data: cerrarTurno
          ? { Activa: false, Estado: 'CERRADA', Fecha_Cierre: conHora(fecha, 18, 0), Saldo_Actual: '0.0000' }
          : { Saldo_Actual: aDecimal(saldoD4) }, // turno abierto: refleja el saldo vivo
      });
    });

    const marca = cerrarTurno ? 'cerrado' : 'ABIERTO';
    console.log(
      `  [${fecha.toISOString().slice(0, 10)}] turno #${turno.Caja_ID} ${marca.padEnd(7)} · ` +
        `${movimientosDelDia.length} movs · tasa ${aDecimal(tasaD4)} · ` +
        `saldo final $${aDecimal(saldoD4)}`,
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VERIFICACION DE INTEGRIDAD (la razon de ser del stress test)
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  VERIFICACION DE INTEGRIDAD (arqueo por turno)');
  console.log('──────────────────────────────────────────────────────────────');

  const turnos = await prisma.caja.findMany({
    where: { Caja_ID: { in: idsTurnosCreados } },
    include: { movimientos: true },
    orderBy: { Fecha_Apertura: 'asc' },
  });

  let turnosRevisados = 0;
  let turnosConDescuadre = 0;
  let diferenciaMaxima = 0n;

  for (const t of turnos) {
    // Misma formula corregida de getHistoricoArqueos: el fondo de apertura
    // NO se suma como ingreso porque ya vive en Saldo_Inicial.
    let ingresosD4 = 0n, egresosOpD4 = 0n, entregadoD4 = 0n;
    for (const m of t.movimientos) {
      const montoD4 = toD4(m.Monto_USD);
      const concepto = (m.Concepto ?? '').trim();
      if (m.Tipo === 'INGRESO') {
        if (concepto.startsWith('Apertura de caja')) continue;
        // Mismo criterio que el backend (getHistoricoArqueos): el arqueo cuenta
        // SOLO efectivo físico. Los cobros digitales van al banco.
        if (!esEfectivo(m.Metodo_Pago)) continue;
        ingresosD4 = addD4(ingresosD4, montoD4);
      } else if (m.Tipo === 'EGRESO') {
        if (concepto.startsWith('Cierre de caja')) entregadoD4 = addD4(entregadoD4, montoD4);
        else if (esEfectivo(m.Metodo_Pago)) egresosOpD4 = addD4(egresosOpD4, montoD4);
      }
    }
    const esperadoD4 = subD4(addD4(toD4(t.Saldo_Inicial), ingresosD4), egresosOpD4);
    turnosRevisados++;

    if (t.Estado !== 'CERRADA') continue; // los abiertos no se han entregado

    const diff = esperadoD4 > entregadoD4
      ? subD4(esperadoD4, entregadoD4)
      : subD4(entregadoD4, esperadoD4);
    if (diff > diferenciaMaxima) diferenciaMaxima = diff;
    // Tolerancia de 1 centavo: cualquier cosa mayor indica deriva real.
    if (diff > toD4('0.0100')) {
      turnosConDescuadre++;
      console.error(
        `  ✖ Turno #${t.Caja_ID}: esperado $${aDecimal(esperadoD4)} vs ` +
          `entregado $${aDecimal(entregadoD4)} (diff $${aDecimal(diff)})`,
      );
    }
  }

  console.log(`  Turnos revisados ......... ${turnosRevisados}`);
  console.log(`  Turnos con descuadre ..... ${turnosConDescuadre}`);
  console.log(`  Diferencia maxima ........ $${aDecimal(diferenciaMaxima)}`);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  RESUMEN');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  Turnos de caja ....... ${totales.turnos}`);
  console.log(`  Movimientos .......... ${totales.movimientos}`);
  console.log(`  Facturas ............. ${totales.facturas}`);
  console.log(`  Renglones de venta ... ${totales.renglones}`);
  console.log(`  Pagos ................ ${totales.pagos}`);
  console.log(`  Notas de entrega ..... ${totales.notas}`);
  console.log(`  Series BCV ........... ${op.dias}`);
  console.log(`  Dias omitidos ........ ${diasOmitidos} (ya tenian turno real)`);
  console.log('──────────────────────────────────────────────────────────────');

  if (turnosConDescuadre === 0) {
    console.log('\n✔ SEED COMPLETADO: todos los arqueos cuadran al centavo.\n');
  } else {
    console.error(`\n✖ SEED COMPLETADO CON ${turnosConDescuadre} ARQUEO(S) DESCUADRADOS.\n`);
  }

  // Aviso util: relanzar el seed sobre el mismo rango NO acumula datos,
  // porque la Guardia 2 respeta la regla de "un turno por jornada" y omite
  // los dias que ya tienen turno (real o del propio seed). Sin este aviso
  // parece que el script "no hace nada".
  if (totales.facturas === 0 && totales.notas === 0) {
    console.log(
      '  AVISO: no se generaron datos nuevos. Todas las jornadas del rango\n' +
        '  ya tenian un turno de caja (regla de negocio: un turno por dia).\n' +
        '  Para acumular mas volumen:\n' +
        '    npm run seed:stress -- --reset && npm run seed:stress -- --dias=90\n' +
        '  o simplemente amplia el rango: --dias=120\n',
    );
  }
  console.log('  Para borrar estos datos: npm run seed:stress -- --reset\n');
}

// ── Punto de entrada: nunca deja la conexion abierta ───────────────────────
seed()
  .catch((e) => {
    console.error('\n✖ El seed fallo:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect(); // cierra el pool: sin fugas de conexiones
  });
