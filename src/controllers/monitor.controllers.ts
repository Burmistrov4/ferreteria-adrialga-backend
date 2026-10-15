import { Request, Response } from 'express';
import { prisma } from '../config/db';

/**
 * Monitor de Base de Datos (presentación en vivo).
 *
 * Lee el esquema REAL desde information_schema de la base conectada (nunca
 * código muerto ni JSON prefabricado): tablas, columnas, PK/FK y conteo
 * EXACTO de filas (COUNT(*) por tabla; ver nota más abajo). Sirve al frontend
 * del "Monitor de BD", que dibuja el diagrama estilo drawdb y lo anima con los
 * eventos db_update de Socket.IO.
 *
 * Modos:
 *  - modo=presentacion → únicamente las 12 tablas del modelo expuesto.
 *  - modo=full         → todas las tablas de la base actual.
 *
 * Solo lectura: una consulta a metadatos de information_schema; jamás toca
 * datos de negocio. Protegido con JWT como el resto de la API.
 */

// Las 12 tablas de la exposición (mismo conjunto del modelo ER presentado).
const TABLAS_PRESENTACION = [
  'usuarios',
  'clientes',
  'proveedores',
  'categorias',
  'productos',
  'caja',
  'movimientos_caja',
  'facturas',
  'detalle_facturas',
  'pagos',
  'notas_entrega_entrada',
  'detalle_notas_entrega',
];

interface ColumnaRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  COLUMN_KEY: string; // PRI | MUL | UNI | ''
  /** Estimación de InnoDB. Solo se usa como respaldo si el COUNT(*) falla. */
  TABLE_ROWS: number | bigint;
}

interface FkRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

export const getEsquemaMonitor = async (req: Request, res: Response) => {
  try {
    const modo =
      (req.query.modo ?? 'presentacion').toString().toLowerCase() === 'full'
        ? 'full'
        : 'presentacion';

    // Filtro de tablas según modo (se interpola como lista IN literal, seguro:
    // los nombres son constantes del código, no entrada libre del usuario).
    const lista =
      TABLAS_PRESENTACION.map((t) => `'${t}'`).join(',');
    const filtroColumnas =
      modo === 'presentacion' ? `AND c.TABLE_NAME IN (${lista})` : '';
    const filtroFks =
      modo === 'presentacion' ? `AND TABLE_NAME IN (${lista})` : '';

    const columnas = await prisma.$queryRawUnsafe<ColumnaRow[]>(
      `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_TYPE, c.COLUMN_KEY,
              t.TABLE_ROWS
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t
           ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() ${filtroColumnas} AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
    );

    const fks = await prisma.$queryRawUnsafe<FkRow[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
        ${filtroFks}`
    );

    // FK reales: `COLUMN_KEY === 'MUL'` significa "indexado", NO "clave
    // foránea" — marcaría columnas indexadas sin FK como si lo fueran. La
    // verdad está en KEY_COLUMN_USAGE.
    const clavesFk = new Set(fks.map((f) => `${f.TABLE_NAME}.${f.COLUMN_NAME}`));

    // Agrupar columnas por tabla.
    const mapa = new Map<
      string,
      {
        nombre: string;
        filas: number;
        /**
         * Filas "vivas" (Activo = 1) cuando la tabla tiene la columna `Activo`.
         * `null` cuando no existe tal columna (facturas, pagos, movimientos…):
         * ahí "activo" no significa nada y no se debe inventar un número.
         */
        activos: number | null;
        columnas: Array<{
          nombre: string;
          tipo: string;
          pk: boolean;
          fk: boolean;
        }>;
      }
    >();
    // Tablas con borrado lógico. Se detecta desde el propio esquema, no por
    // una lista escrita a mano (si mañana se añade `Activo` a otra tabla, el
    // Monitor la reconoce sola). Se guarda el nombre EXACTO de la columna
    // (`Activo` o `Activa`, según la tabla) porque el SQL solo puede referirse
    // a la que realmente existe; nombrar la otra rompería toda la consulta.
    const columnaActivo = new Map<string, string>();
    for (const c of columnas) {
      if (c.COLUMN_NAME === 'Activo' || c.COLUMN_NAME === 'Activa') {
        columnaActivo.set(c.TABLE_NAME, c.COLUMN_NAME);
      }
      if (!mapa.has(c.TABLE_NAME)) {
        mapa.set(c.TABLE_NAME, {
          nombre: c.TABLE_NAME,
          filas: Number(c.TABLE_ROWS ?? 0),
          activos: null,
          columnas: [],
        });
      }
      mapa.get(c.TABLE_NAME)!.columnas.push({
        nombre: c.COLUMN_NAME,
        tipo: c.COLUMN_TYPE,
        pk: c.COLUMN_KEY === 'PRI',
        fk: clavesFk.has(`${c.TABLE_NAME}.${c.COLUMN_NAME}`),
      });
    }

    // ── Conteo EXACTO de filas ─────────────────────────────────────────────
    // `information_schema.TABLES.TABLE_ROWS` es una ESTIMACIÓN en InnoDB y puede
    // desviarse mucho. El Monitor existe para demostrar la base REAL en vivo:
    // mostrar "7.061 productos" donde hay 100 activos destruye la credibilidad
    // del dato (medido el 2026-10-14). Se cuenta con COUNT(*) por tabla en una
    // sola consulta UNION ALL.
    //
    // Además se cuenta `activos` (Activo = 1) en la MISMA pasada: el recorte del
    // catálogo es soft-delete, así que `productos` tiene ~7.278 filas totales
    // pero solo 100 vigentes. Sin este dato el Monitor parecía contradecir al
    // Dashboard ("100 ítems"). Cada tabla paga como máximo un COUNT extra.
    const nombreSeguro = /^[A-Za-z0-9_]+$/;
    const nombres = [...mapa.keys()].filter((n) => nombreSeguro.test(n));
    if (nombres.length > 0) {
      try {
        const union = nombres
          .map((n) => {
            const col = columnaActivo.get(n);
            const activos = col
              ? `SUM(CASE WHEN \`${col}\` = 1 THEN 1 ELSE 0 END)`
              : 'NULL';
            return (
              `SELECT '${n}' AS tabla, COUNT(*) AS filas, ${activos} AS activos ` +
              `FROM \`${n}\``
            );
          })
          .join(' UNION ALL ');
        const conteos = await prisma.$queryRawUnsafe<
          Array<{ tabla: string; filas: number | bigint; activos: number | bigint | null }>
        >(union);
        for (const c of conteos) {
          const t = mapa.get(String(c.tabla));
          if (!t) continue;
          t.filas = Number(c.filas ?? 0);
          t.activos = c.activos === null || c.activos === undefined
            ? null
            : Number(c.activos);
        }
      } catch (e) {
        // Degradar al estimado en vez de romper el Monitor completo.
        console.warn(
          'Monitor: COUNT(*) falló, se usa la estimación de TABLE_ROWS:',
          e
        );
      }
    }

    // En modo presentación solo se dibujan relaciones entre tablas visibles.
    const visibles = new Set(mapa.keys());
    const relaciones = fks
      .filter(
        (f) => visibles.has(f.TABLE_NAME) && visibles.has(f.REFERENCED_TABLE_NAME)
      )
      .map((f) => ({
        desde: f.TABLE_NAME,
        columna: f.COLUMN_NAME,
        hasta: f.REFERENCED_TABLE_NAME,
        referencia: f.REFERENCED_COLUMN_NAME,
      }));

    // Orden de presentación fijo para el layout estable (modo presentación).
    let tablas = [...mapa.values()];
    if (modo === 'presentacion') {
      tablas.sort(
        (a, b) =>
          TABLAS_PRESENTACION.indexOf(a.nombre) - TABLAS_PRESENTACION.indexOf(b.nombre)
      );
    } else {
      tablas.sort((a, b) => a.nombre.localeCompare(b.nombre));
    }

    // Totales globales: el encabezado del Monitor los muestra junto al badge de
    // la base para explicar de un vistazo por qué el Dashboard dice "100 ítems"
    // y la tabla `productos` tiene miles de filas (recorte por soft-delete).
    const resumen = {
      tablas: tablas.length,
      filas: tablas.reduce((t, x) => t + x.filas, 0),
      activos: tablas.reduce((t, x) => t + (x.activos ?? 0), 0),
      // Tablas que participan del conteo de "activos" (tienen columna Activo).
      tablasConActivo: tablas.filter((t) => t.activos !== null).length,
    };

    return res.json({
      modo,
      base: process.env.DATABASE_URL
        ? (() => {
            try {
              const u = new URL(process.env.DATABASE_URL!);
              return u.pathname.replace(/^\//, '').split('/')[0]; // solo el nombre de la base
            } catch {
              return null;
            }
          })()
        : null,
      generadoEn: new Date().toISOString(),
      resumen,
      tablas,
      relaciones,
    });
  } catch (error) {
    console.error('Error en monitor/esquema:', error);
    return res.status(500).json({ message: 'Error al leer el esquema de la base de datos' });
  }
};
