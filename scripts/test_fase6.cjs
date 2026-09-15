const b = 'http://localhost:3000/api';
(async () => {
  const l = await (await fetch(b + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  })).json();
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token };

  // 0) categoría con margen sugerido 40%
  let r = await fetch(b + '/categorias', { method: 'POST', headers: h, body: JSON.stringify({ Nombre: 'Cat Fase6 Test', Descripcion: 'test', Margen_Sugerido: 40 }) });
  const cat = await r.json();
  console.log('categoria:', r.status, cat.Categoria_ID, 'margenSugerido=', cat.Margen_Sugerido);

  // 1) producto sin margen propio → hereda de categoría
  r = await fetch(b + '/productos', { method: 'POST', headers: h, body: JSON.stringify({ Nombre: 'Prod Fase6', Categoria_ID: cat.Categoria_ID, Costo_Ultimo: 10, Stock_Actual: 0, Precio_Venta: 20 }) });
  const p = await r.json();
  console.log('producto:', r.status, 'id', p.Producto_ID, 'precio', p.Precio_Venta, '(mantiene el enviado)');

  // 2) entrada de mercancía con costo 5 → CPP directo (stock 0) y precio recalculado con margen heredado 40%
  r = await fetch(b + '/notas', {
    method: 'POST', headers: h, body: JSON.stringify({
      Proveedor_ID: null, Forma_Pago: 'Credito',
      Numero_Nota: 'NE-F6-' + Date.now(),
      detalles: [{ Producto_ID: p.Producto_ID, Cantidad: 10, Costo_Unitario: 5 }]
    })
  });
  const nota = await r.json();
  console.log('nota credito:', r.status, JSON.stringify(nota).slice(0, 120));

  // leer producto para ver CPP + precio recalculado
  r = await fetch(b + '/productos', { headers: h });
  const prods = await r.json();
  const act = prods.find(x => x.Producto_ID === p.Producto_ID);
  console.log('producto tras entrada: stock', act.Stock_Actual, 'CPP', act.Costo_Promedio, 'precio', act.Precio_Venta, '(esperado 5 * 1.40 = 7)');

  // 3) variante con margen propio (25) → PATCH
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes/bulk', {
    method: 'POST', headers: h, body: JSON.stringify({
      variantes: [{ sku: 'F6-UNICA', atributos: { Color: 'Gris' }, stock: 0, costo: 5, precio: 7 }]
    })
  });
  const bulk = await r.json();
  console.log('bulk:', r.status, JSON.stringify(bulk));
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes', { headers: h });
  const m = await r.json();
  const v1 = m.matriz.find(v => v.sku === 'F6-UNICA');
  console.log('variante: margenPropio=', v1.margenPropio, 'margenEfectivo=', v1.margenEfectivo, '(esperado 40 heredado)');

  // PATCH margen propio 25
  r = await fetch(b + '/productos/variantes/' + v1.varianteId, { method: 'PATCH', headers: h, body: JSON.stringify({ margen: 25 }) });
  console.log('patch margen:', r.status);
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes', { headers: h });
  const v2 = (await r.json()).matriz.find(v => v.sku === 'F6-UNICA');
  console.log('variante: margenPropio=', v2.margenPropio, 'margenEfectivo=', v2.margenEfectivo, '(esperado 25 propio)');

  // 4) limpieza
  await fetch(b + '/productos/' + p.Producto_ID, { method: 'DELETE', headers: h });
  await fetch(b + '/categorias/' + cat.Categoria_ID, { method: 'DELETE', headers: h });
  console.log('limpieza ok');
})().catch(e => console.error(e));
