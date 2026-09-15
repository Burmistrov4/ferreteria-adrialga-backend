const b = 'http://localhost:3000/api';
(async () => {
  const l = await (await fetch(b + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  })).json();
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token };

  // producto de prueba
  let r = await fetch(b + '/productos', { method: 'POST', headers: h, body: JSON.stringify({ Nombre: 'Test Variantes F5', Categoria_ID: 1, Costo_Ultimo: 10, Margen_Ganancia: 50, Stock_Actual: 5 }) });
  const p = await r.json();
  console.log('producto:', r.status, 'id', p.Producto_ID, 'precio', p.Precio_Venta, '(esperado 15)');

  // bulk de 2×2
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes/bulk', {
    method: 'POST', headers: h, body: JSON.stringify({
      variantes: [
        { sku: 'TEST-V1-ROJO-S', atributos: { Color: 'Rojo', Talla: 'S' }, stock: 3, costo: 10, precio: 15 },
        { sku: 'TEST-V1-ROJO-M', atributos: { Color: 'Rojo', Talla: 'M' }, stock: 4, costo: 10, precio: 15 },
        { sku: 'TEST-V1-AZUL-S', atributos: { Color: 'Azul', Talla: 'S' }, stock: 2, costo: 10, precio: 15 },
      ]
    })
  });
  console.log('bulk:', r.status, JSON.stringify(await r.json()));

  // GET matriz
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes', { headers: h });
  const j = await r.json();
  console.log('matriz:', r.status, 'ejes=', JSON.stringify(j.ejes), 'filas=', j.matriz.length);
  console.log('sample:', JSON.stringify(j.matriz[0]));

  // PATCH inline
  const vid = j.matriz[0].varianteId;
  r = await fetch(b + '/productos/variantes/' + vid, { method: 'PATCH', headers: h, body: JSON.stringify({ stock: 99, precio: 17.5 }) });
  console.log('patch:', r.status, JSON.stringify(await r.json()));

  // idempotencia re-correr bulk
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes/bulk', {
    method: 'POST', headers: h, body: JSON.stringify({
      variantes: [{ sku: 'TEST-V1-ROJO-S', atributos: { Color: 'Rojo', Talla: 'S' }, stock: 5, costo: 10, precio: 15 }]
    })
  });
  console.log('bulk repeat:', r.status);
  r = await fetch(b + '/productos/' + p.Producto_ID + '/variantes', { headers: h });
  console.log('filas tras repeat:', (await r.json()).matriz.length);

  // Limpieza: borrar variantes y producto
  const jj = (await (await fetch(b + '/productos/' + p.Producto_ID + '/variantes', { headers: h })).json());
  for (const v of jj.matriz) {
    await fetch('http://localhost:3000/api/productos/variantes/' + v.varianteId, { headers: h }).catch(() => {});
  }
  await fetch(b + '/productos/' + p.Producto_ID, { method: 'DELETE', headers: h });
  console.log('limpieza ok');
})().catch(e => console.error(e));
