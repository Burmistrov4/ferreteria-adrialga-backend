/**
 * audit_libro_diario.ts — Dispara exportarLibroDiario con un req/res simulado
 * y vuelca las primeras 5 líneas del CSV para la auditoría FASE D1.
 */
import { exportarLibroDiario } from '../src/controllers/dashboard.controllers';

async function main() {
  const captura: { csv?: string } = {};
  const res: any = {
    setHeader() {},
    json() {},
    send(s: string) {
      captura.csv = s;
    },
  };
  const req: any = { query: { periodo: 'anio', formato: 'csv' } };

  await exportarLibroDiario(req, res);

  if (!captura.csv) {
    console.error('No se produjo CSV.');
    process.exitCode = 1;
    return;
  }
  const limpio = captura.csv.replace(/^\ufeff/, ''); // quita BOM para lectura
  const lineas = limpio.split('\n');
  console.log('--- Encabezado + 1 fila de datos + totales (Libro Diario) ---');
  console.log(lineas.slice(0, 7).join('\n'));
  console.log('...');
  console.log(lineas[lineas.length - 1]);
  console.log('--- Total de líneas:', lineas.length, '---');
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
