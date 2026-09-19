# Ferretería Adrialga — Sistema de Gestión Integral (Backend)

**Versión de entrega: v3.0.0-release**
Arquitectura de grado empresarial para la gestión de punto de venta, inventario multidimensional, tesorería y reportes fiscales de una ferretería minorista.

---

## 1. Ficha Técnica y Arquitectura

| Capa | Implementación |
|---|---|
| Runtime / Lenguaje | Node.js 24 + TypeScript 5 (tipado estricto) |
| Framework HTTP | Express (middlewares de autenticación JWT y CORS) |
| ORM / Base de datos | Prisma 6 + MySQL 8 (producción en Railway) |
| Seguridad | Bcrypt (PINs de supervisor), JWT con expiración |
| Validación financiera | Decimal ARITMÉTICA entera granular (`bigint` D4) |

**Arquitectura por capas**

```
src/
├─ middlewares/   # auth.middleware.ts (JWT), guard de contadores reglamentarios
├─ controllers/   # Lógica de negocio (facturas, notas, caja, productos, etc.)
├─ routes/        # Definición pública de la API REST
├─ services/      # Tanques (tasa BCV, numeración fiscal), SENI/VT-CSV
└─ utils/         # aritmética D4, reglas fiscales, helpers
scripts/          # smoke_e2e.js + tests de fases, migraciones de datos
prisma/schema.prisma → Modelo relacional formal
```

### Garantías ACID y Transacciones atómicas

* **Facturación completa en un solo `prisma.$transaction{...}`** (header + ítems + pagos + movimientos de caja): si cualquier paso falla el rollback es integral, sin estados huérfanos.
* **Descuento de inventario con guardia de concurrencia**: `updateMany({ where: { Stock_Actual: { gte: cantidad } }, data: { Stock_Actual: { decrement: ... } } })`; si `count===0` la transacción aborta — dos cajeros jamás venden el mismo "último producto" el mismo día.
* **Separación físico/digital en Tesorería**: solo los pagos cuyo `Metodo_Pago` es "Efectivo USD/VES" alteran `caja.Saldo_Actual`; transferencias digitales se auditan en `movimientos_caja` pero **no contaminan** el zócalo físico (evita descuadres de arqueo).
* **Cierre de caja con arqueo matemático** (`utils/arqueo.ts`): `Contado - Esperado` con tolerancia de medio céntimo de dólar (`0.005`); estados explícitos `MATCH`, `SURPLUS`, `DEFICIT`.
* **Soft-delete para variantes y productos**: `Activo=false` para preservar obligaciones fiscales (fila existente en historial de negocios) y la reversión de facturas devuelve el stock incluso a ítems suppressados del catálogo.

## 2. Mapa de Módulos y Flujos Operativos

| Módulo | Función central | Puntos críticos fijados |
|---|---|---|
| **POS / Facturación** | Emisión de tickets/PDF, pago mixto con IGTF, devolución (NC) | Hidratación de facturas/NC con cliente, usuario, ítems y pagos (sin re-consulta post-pago); tolerancia de redondeóferico (`±0.005`) |
| **Inventario** | CRUD de productos + varia ntetAPO cartesiana N-dimensionales | Herencia automática de margen (Categoría > Config global > Manual) con override del usuario |
| **Tesorería** | Arqueo Z, egresos, ingresos| Asimetría caja-física vs datos bancarios sellada con `esEfectivo()` |
| **Anticipos / CxP** | Compras a crédito y contado con CMP (costo medio ponderado) | Recalcula CMP y derivado del último coste (costaPin soporte on the backfill) |
| **Backend de reportes** | Exportadores SENIAT (CSV camión real), series de rentabilidad histórica | Linea de comando `npm run reporte...` para auditorías rápidas |

## 3. Guía de Despliegue (desarrollo → producción)

### Backend (Node.js / TypeScript)

```bash
cd adrialga-backend
npm install
# Asegura que DATABASE_URL en .env apunta a la instancia MySQL de Railway
npx prisma db push      # aplica las migraciones sin datos pre-existentes
npx prisma generate     # regenera herramientas cliente
npm run dev             # servidor API en :3000 (por defecto)
node scripts/smoke_e2e.js   # verificación integral del motor financiero
```

### Frontend (Flutter Web)

```bash
cd adrialga_frontend
flutter pub get
flutter run -d chrome --web-port 5000
# Producción (GitHub Pages):
flutter build web --release --base-href /ferreteria-adrialga-frontend/
```

## 4. Matriz de Pruebas y Control de Calidad

| Herramienta | Comando | Alcance |
|---|---|---|
| Tipado TS | `npx tsc --noEmit` | Compilación estricta de controladores y rutas; 0 warnings en `strict` |
| Analizador Flutter | `flutter analyze` | Errores de tipeo/imports/ui |
| Pruebas Flutter | `flutter test` | 46/tests unitarios: cobro con precisión, parsejo seguro de Prisma Decimal, navegación condicional, temas |
| Prueba de humo e2e | `node scripts/smoke_e2e.js` | Flujo financiero completo (crear catálogo + ventas + reversas, aranceles correctos) |
| Suite matricial carga | `scripts/test_fase5_variantes.cjs` | Idempotencia de upsert, herencia de datos y soft-delete -seguridad |

**Todas las pruebas pasan con el release actual.**

## 5. Señalética visual y estándares de impresión

* Fuentes locales: `assets/fonts/Roboto-Regular.ttf` y `Roboto-Bold.ttf` (offline).
* Formatas térmicos 57mm y 80mm; impresión A4 full-color. Impresora térmica diferida ESC/POS via `Printing.layoutPdf`.
* UI sigue Material Design 3 con temas claro/oscuro y controles con foco de tabulación teclado.

### Ayuda rápida (desarrollador)

```bash
# Cambiar una tasa de cambio manual
node scripts/set_tasa.cjs "672.4700" "USD"
# Test de safe decreeo procintóf other
```
