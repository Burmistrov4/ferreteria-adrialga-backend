// Verificacion temporal (sin BD): reproduce la misma secuencia del seed
// (apertura, ventas, compras, fondo, cierre) y comprueba que el historico de
// arqueo cuadra al centavo con la formula corregida.
import { toD4, addD4, subD4, mulD4, divD4, aDecimal, IVA_ALIQUOTA, CIEN } from '../src/utils/dinero';

function mulberry32(s: number) {
  let a = s >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let fallos = 0;
let revisados = 0;
const rng = mulberry32(20260926);
const fondoD4 = toD4('60.0000');

for (let dia = 0; dia < 45; dia++) {
  let saldoD4 = fondoD4;                  // espejo de caja.Saldo_Actual
  let ingresosD4 = 0n;
  let egresosOpD4 = 0n;
  const saldoInicialD4 = fondoD4;
  const aperturaD4 = fondoD4;             // movimiento de apertura (no suma a Saldo_Actual)

  for (let v = 0; v < 12; v++) {
    const renglones = 1 + Math.floor(rng() * 4);
    let subtotalD4 = 0n;
    for (let r = 0; r < renglones; r++) {
      const costoD4 = toD4((1 + Math.floor(rng() * 40)) + Math.floor(rng() * 99) / 100);
      const precioD4 = mulD4(costoD4, toD4('1.3'));
      const cantidad = 1 + Math.floor(rng() * 5);
      subtotalD4 = addD4(subtotalD4, mulD4(precioD4, toD4(cantidad)));
    }
    const ivaD4 = divD4(mulD4(subtotalD4, IVA_ALIQUOTA), CIEN);
    const pagaDivisa = rng() < 0.3;
    const montoDivisaD4 = pagaDivisa
      ? divD4(mulD4(addD4(subtotalD4, ivaD4), toD4('60')), CIEN)
      : 0n;
    const igtfD4 = pagaDivisa ? divD4(mulD4(montoDivisaD4, toD4('3')), CIEN) : 0n;
    const totalD4 = addD4(addD4(subtotalD4, ivaD4), igtfD4);
    saldoD4 = addD4(saldoD4, totalD4);
    ingresosD4 = addD4(ingresosD4, totalD4);
  }

  for (let c = 0; c < 3; c++) {
    const renglones = 1 + Math.floor(rng() * 3);
    let totalCostoD4 = 0n;
    for (let r = 0; r < renglones; r++) {
      const costoD4 = toD4((1 + Math.floor(rng() * 40)) + Math.floor(rng() * 99) / 100);
      const cantidad = 5 + Math.floor(rng() * 40);
      totalCostoD4 = addD4(totalCostoD4, mulD4(costoD4, toD4(cantidad)));
    }
    const esCredito = rng() < 0.5;
    if (!esCredito) {
      saldoD4 = subD4(saldoD4, totalCostoD4);
      egresosOpD4 = addD4(egresosOpD4, totalCostoD4);
    }
  }

  if (rng() < 0.2) {
    const extraD4 = mulD4(fondoD4, toD4('0.5'));
    saldoD4 = addD4(saldoD4, extraD4);
    ingresosD4 = addD4(ingresosD4, extraD4);
  }

  const entregadoD4 = saldoD4;            // EGRESO "Cierre de caja"
  const esperadoD4 = subD4(addD4(saldoInicialD4, ingresosD4), egresosOpD4);
  const diff = esperadoD4 > entregadoD4
    ? subD4(esperadoD4, entregadoD4)
    : subD4(entregadoD4, esperadoD4);

  revisados++;
  if (diff > toD4('0.0100')) {
    fallos++;
    console.error(
      '  dia ' + dia + ': esperado ' + aDecimal(esperadoD4) +
      ' vs entregado ' + aDecimal(entregadoD4) + ' (diff ' + aDecimal(diff) + ')',
    );
  }

  // Contra-prueba: con la formula VIEJA (sumando la apertura como ingreso)
  // el descuadre es EXACTAMENTE el fondo, en todos los turnos.
  const esperadoViejo = subD4(addD4(addD4(saldoInicialD4, aperturaD4), ingresosD4), egresosOpD4);
  const diffViejo = subD4(esperadoViejo, entregadoD4);
  if (diffViejo !== fondoD4) {
    console.error('  dia ' + dia + ': la formula vieja no descontaba exactamente el fondo');
    fallos++;
  }
}

console.log('Turnos simulados: ' + revisados);
console.log('Descuadres con formula CORREGIDA: ' + fallos);
console.log('Formula VIEJA descontaba ' + aDecimal(fondoD4) + ' en CADA turno cerrado (DEFICIT falso).');
console.log(fallos === 0 ? 'ARITMETICA DEL SEED VERIFICADA: cuadra al centavo.' : 'FALLO LA VERIFICACION');
