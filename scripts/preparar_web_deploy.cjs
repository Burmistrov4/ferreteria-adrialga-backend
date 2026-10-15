// Copia la build de Flutter Web a `adrialga-backend/web/`, que es la ruta que
// Render despliega.
//
// Motivo: en Render el sistema de archivos es EFÍMERO (se pierde al redesplegar,
// reiniciar o al apagar la instancia por inactividad), así que la web no puede
// montarse desde fuera del repositorio. La build tiene que estar versionada.
//
// El backend ya sirve la web desde el mismo origen que la API: un solo servicio,
// sin CORS y sin recompilar el frontend con una URL absoluta.
//
// Uso:  node scripts/preparar_web_deploy.cjs
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ORIGEN = path.resolve(__dirname, '../../adrialga_frontend/build/web');
const DESTINO = path.resolve(__dirname, '../web');

/** Copia recursiva que solo reescribe lo que cambió (tamaño o fecha). */
function copiarDir(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entrada of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entrada.name);
    const d = path.join(dst, entrada.name);
    if (entrada.isDirectory()) {
      copiarDir(s, d, stats);
      continue;
    }
    if (!entrada.isFile()) continue;
    const stSrc = fs.statSync(s);
    stats.bytes += stSrc.size;
    stats.archivos++;

    if (fs.existsSync(d)) {
      const stDst = fs.statSync(d);
      if (stDst.size === stSrc.size && stDst.mtimeMs >= stSrc.mtimeMs) {
        stats.sinCambios++;
        continue;
      }
    }
    fs.copyFileSync(s, d);
    stats.copiados++;
  }
}

(async () => {
  if (!fs.existsSync(ORIGEN)) {
    console.error(`✖ No existe la build de Flutter en: ${ORIGEN}`);
    console.error('  Ejecuta primero, en adrialga_frontend:  flutter build web --release');
    process.exit(2);
  }

  // Comprobación de que la carpeta es realmente una build de Flutter.
  for (const obligatorio of ['index.html', 'main.dart.js', 'flutter_bootstrap.js']) {
    if (!fs.existsSync(path.join(ORIGEN, obligatorio))) {
      console.error(`✖ La carpeta no parece una build de Flutter: falta ${obligatorio}`);
      process.exit(3);
    }
  }

  const stats = { archivos: 0, copiados: 0, sinCambios: 0, bytes: 0 };
  copiarDir(ORIGEN, DESTINO, stats);

  const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
  console.log('=== BUILD WEB COPIADA AL REPOSITORIO DEL BACKEND ===\n');
  console.log(`  origen   : ${ORIGEN}`);
  console.log(`  destino  : ${DESTINO}`);
  console.log(`  archivos : ${stats.archivos} · ${mb(stats.bytes)}`);
  console.log(`  copiados : ${stats.copiados}`);
  console.log(`  sin cambios: ${stats.sinCambios}`);
  console.log('');
  console.log('  Recuerda versionar la carpeta `web/`: es lo que Render despliega.');

  // Aviso si la build es más antigua que el código fuente: sería servir una
  // versión vieja del frontend, que es exactamente el síntoma de "recompilé y
  // veo el mismo diseño de siempre".
  const libDir = path.resolve(__dirname, '../../adrialga_frontend/lib');
  if (fs.existsSync(libDir)) {
    const mtimeBuild = fs.statSync(path.join(ORIGEN, 'main.dart.js')).mtimeMs;
    let masReciente = 0;
    const recorrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) recorrer(p);
        else masReciente = Math.max(masReciente, fs.statSync(p).mtimeMs);
      }
    };
    recorrer(libDir);
    if (masReciente > mtimeBuild) {
      console.warn(
        '  ⚠ El código en adrialga_frontend/lib es más reciente que la build.\n' +
          '    Vuelve a ejecutar `flutter build web --release` antes de desplegar.'
      );
    }
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
