const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const cats = await p.categorias.findMany();
  console.log(cats.map(c => `${c.Categoria_ID}: ${c.Nombre} [${c.Prefijo_SKU}]`).join('\n'));

  // Backfill: si alguna categoría no tiene Prefijo_SKU, derivarlo de las 3
  // primeras letras del nombre en mayúsculas y ajustar manualmente si hay choques.
  const usados = new Set();
  for (const c of cats) {
    if (c.Prefijo_SKU && c.Prefijo_SKU.length === 3) { usados.add(c.Prefijo_SKU); continue; }
    let prefijo = c.Nombre.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
    while (usados.has(prefijo)) prefijo = prefijo.slice(0, 2) + 'Z';
    await p.categorias.update({ where: { Categoria_ID: c.Categoria_ID }, data: { Prefijo_SKU: prefijo } });
    usados.add(prefijo);
    console.log(`Backfill -> Categoria ${c.Categoria_ID} (${c.Nombre}) = ${prefijo}`);
  }
  await p.$disconnect();
})();
