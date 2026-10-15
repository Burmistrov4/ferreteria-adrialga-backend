-- Schema-only adrialga para DrawDB
CREATE TABLE IF NOT EXISTS `caja` (
  `Caja_ID` int NOT NULL AUTO_INCREMENT,
  `Nombre` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Saldo_Inicial` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Saldo_Actual` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Fecha_Apertura` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Estado` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ABIERTA',
  `Fecha_Cierre` timestamp NULL DEFAULT NULL,
  `Activa` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`Caja_ID`),
  KEY `IDX_Caja_Activa` (`Activa`)
) ENGINE = InnoDB AUTO_INCREMENT = 12 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `categorias` (
  `Categoria_ID` int NOT NULL AUTO_INCREMENT,
  `Nombre` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Descripcion` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Activo` tinyint(1) NOT NULL DEFAULT '1',
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Prefijo_SKU` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'GEN',
  `Margen_Sugerido` decimal(18, 6) DEFAULT NULL,
  PRIMARY KEY (`Categoria_ID`)
) ENGINE = InnoDB AUTO_INCREMENT = 11 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `clientes` (
  `Cliente_ID` int NOT NULL AUTO_INCREMENT,
  `RIF_Cedula` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Razon_Social` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Direccion` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Telefono` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Email` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Num_Documento` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Tipo_Documento` varchar(1) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'V',
  PRIMARY KEY (`Cliente_ID`),
  UNIQUE KEY `RIF_Cedula` (`RIF_Cedula`),
  KEY `IDX_Clientes_NumDocumento` (`Num_Documento`),
  KEY `IDX_Clientes_RazonSocial` (`Razon_Social`)
) ENGINE = InnoDB AUTO_INCREMENT = 16 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `configuracion_tienda` (
  `Config_ID` int NOT NULL AUTO_INCREMENT,
  `Nombre` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `RIF` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Direccion` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Telefono` varchar(25) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Mensaje_Pie` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `Margen_Defecto` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  PRIMARY KEY (`Config_ID`)
) ENGINE = InnoDB AUTO_INCREMENT = 2 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `contadores_fiscales` (
  `Clave` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Valor` int NOT NULL DEFAULT '0',
  UNIQUE KEY `UQ_Contadores_Clave` (`Clave`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `cuentas_por_pagar` (
  `CxP_ID` int NOT NULL AUTO_INCREMENT,
  `Proveedor_ID` int NOT NULL,
  `Nota_ID` int NOT NULL,
  `Monto_Total` decimal(18, 6) NOT NULL,
  `Monto_Pagado` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Saldo` decimal(18, 6) NOT NULL,
  `Fecha` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Vencimiento` timestamp NULL DEFAULT NULL,
  `Estatus` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Pendiente',
  PRIMARY KEY (`CxP_ID`),
  UNIQUE KEY `UQ_CxP_Nota` (`Nota_ID`),
  KEY `FK_CxP_Proveedor` (`Proveedor_ID`),
  KEY `IDX_CxP_Estatus` (`Estatus`),
  CONSTRAINT `FK_CxP_Nota` FOREIGN KEY (`Nota_ID`) REFERENCES `notas_entrega_entrada` (`Nota_ID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_CxP_Proveedor` FOREIGN KEY (`Proveedor_ID`) REFERENCES `proveedores` (`Proveedor_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 7 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `detalle_facturas` (
  `Detalle_ID` int NOT NULL AUTO_INCREMENT,
  `Factura_ID` int NOT NULL,
  `Producto_ID` int NOT NULL,
  `Cantidad` int NOT NULL,
  `Precio_Unitario` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Costo_Unitario_Historico` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Subtotal` decimal(18, 6) DEFAULT NULL,
  `Variante_ID` int DEFAULT NULL,
  PRIMARY KEY (`Detalle_ID`),
  KEY `FK_DetalleFactura_Facturas` (`Factura_ID`),
  KEY `IDX_DetalleFacturas_Producto` (`Producto_ID`),
  KEY `IDX_DetalleFacturas_Variante` (`Variante_ID`),
  CONSTRAINT `FK_DetalleFactura_Facturas` FOREIGN KEY (`Factura_ID`) REFERENCES `facturas` (`Factura_ID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_DetalleFactura_Productos` FOREIGN KEY (`Producto_ID`) REFERENCES `productos` (`Producto_ID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_DetalleFactura_Variante` FOREIGN KEY (`Variante_ID`) REFERENCES `producto_variantes` (`Variante_ID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 124 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `detalle_notas_entrega` (
  `Detalle_Nota_ID` int NOT NULL AUTO_INCREMENT,
  `Nota_ID` int NOT NULL,
  `Producto_ID` int NOT NULL,
  `Cantidad` int NOT NULL,
  `Costo_Unitario` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Subtotal_Costo` decimal(18, 6) DEFAULT NULL,
  PRIMARY KEY (`Detalle_Nota_ID`),
  KEY `FK_DetalleNota_Cabecera` (`Nota_ID`),
  KEY `IDX_DetalleNotas_Producto` (`Producto_ID`),
  CONSTRAINT `FK_DetalleNota_Cabecera` FOREIGN KEY (`Nota_ID`) REFERENCES `notas_entrega_entrada` (`Nota_ID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_DetalleNota_Productos` FOREIGN KEY (`Producto_ID`) REFERENCES `productos` (`Producto_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 43 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `facturas` (
  `Factura_ID` int NOT NULL AUTO_INCREMENT,
  `Numero_Control` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Fecha_Emision` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Subtotal` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Total_IVA` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Total_General` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Estatus` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Completada',
  `Tipo_Documento` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'FACTURA',
  `Factura_Afectada_ID` int DEFAULT NULL,
  `Cliente_ID` int NOT NULL,
  `Usuario_ID` int NOT NULL,
  `Tasa_Cambio` decimal(18, 6) NOT NULL DEFAULT '1.000000',
  `Monto_IGTF` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Autorizado_Por_ID` int DEFAULT NULL,
  PRIMARY KEY (`Factura_ID`),
  UNIQUE KEY `Numero_Control` (`Numero_Control`),
  KEY `FK_Facturas_Clientes` (`Cliente_ID`),
  KEY `FK_Facturas_Usuarios` (`Usuario_ID`),
  KEY `IDX_Facturas_Fecha` (`Fecha_Emision`),
  KEY `IDX_Facturas_TipoDoc` (`Tipo_Documento`),
  KEY `IDX_Facturas_Afectada` (`Factura_Afectada_ID`),
  KEY `IDX_Facturas_Autorizado` (`Autorizado_Por_ID`),
  CONSTRAINT `FK_Facturas_AutorizadoPor` FOREIGN KEY (`Autorizado_Por_ID`) REFERENCES `usuarios` (`Usuario_ID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FK_Facturas_Clientes` FOREIGN KEY (`Cliente_ID`) REFERENCES `clientes` (`Cliente_ID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Facturas_Usuarios` FOREIGN KEY (`Usuario_ID`) REFERENCES `usuarios` (`Usuario_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 113 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `movimientos_caja` (
  `Movimiento_ID` int NOT NULL AUTO_INCREMENT,
  `Caja_ID` int NOT NULL,
  `Tipo` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Concepto` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Metodo_Pago` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Monto_USD` decimal(18, 6) NOT NULL,
  `Tasa_Cambio` decimal(18, 6) DEFAULT NULL,
  `Referencia` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Origen_ID` int DEFAULT NULL,
  `Origen_Tipo` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Fecha` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Movimiento_ID`),
  KEY `FK_MovCaja_Caja` (`Caja_ID`),
  KEY `IDX_MovCaja_Origen` (`Origen_Tipo`, `Origen_ID`),
  CONSTRAINT `FK_MovCaja_Caja` FOREIGN KEY (`Caja_ID`) REFERENCES `caja` (`Caja_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 139 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `notas_entrega_entrada` (
  `Nota_ID` int NOT NULL AUTO_INCREMENT,
  `Numero_Nota` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Fecha_Recepcion` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Total_Costo` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Estatus` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Procesada',
  `Proveedor_ID` int NOT NULL,
  `Usuario_ID` int NOT NULL,
  PRIMARY KEY (`Nota_ID`),
  UNIQUE KEY `Numero_Nota` (`Numero_Nota`),
  KEY `FK_Notas_Proveedores` (`Proveedor_ID`),
  KEY `FK_Notas_Usuarios` (`Usuario_ID`),
  KEY `IDX_Notas_Fecha` (`Fecha_Recepcion`),
  CONSTRAINT `FK_Notas_Proveedores` FOREIGN KEY (`Proveedor_ID`) REFERENCES `proveedores` (`Proveedor_ID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Notas_Usuarios` FOREIGN KEY (`Usuario_ID`) REFERENCES `usuarios` (`Usuario_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 43 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `pagos` (
  `Pago_ID` int NOT NULL AUTO_INCREMENT,
  `Factura_ID` int NOT NULL,
  `Metodo_Pago` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Monto` decimal(18, 6) NOT NULL,
  `Referencia` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Fecha_Pago` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Tasa_Cambio` decimal(18, 6) DEFAULT NULL,
  `Es_Divisa` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`Pago_ID`),
  KEY `FK_Pagos_Facturas` (`Factura_ID`),
  CONSTRAINT `FK_Pagos_Facturas` FOREIGN KEY (`Factura_ID`) REFERENCES `facturas` (`Factura_ID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 111 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `producto_variantes` (
  `Variante_ID` int NOT NULL AUTO_INCREMENT,
  `Producto_ID` int NOT NULL,
  `SKU_Variante` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Costo_Unitario` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Precio_Venta` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Margen_Ganancia` decimal(18, 6) DEFAULT NULL,
  `Stock_Actual` int NOT NULL DEFAULT '0',
  `Activo` tinyint(1) NOT NULL DEFAULT '1',
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Variante_ID`),
  UNIQUE KEY `UQ_Variante_SKU` (`SKU_Variante`),
  KEY `IDX_Variantes_Producto` (`Producto_ID`),
  CONSTRAINT `FK_Variantes_Producto` FOREIGN KEY (`Producto_ID`) REFERENCES `productos` (`Producto_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 24 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `productos` (
  `Producto_ID` int NOT NULL AUTO_INCREMENT,
  `SKU_Codigo` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Nombre` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Precio_Venta` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Costo_Promedio` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Stock_Actual` int NOT NULL DEFAULT '0',
  `Stock_Minimo` int NOT NULL DEFAULT '5',
  `Categoria_ID` int NOT NULL,
  `Activo` tinyint(1) NOT NULL DEFAULT '1',
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Costo_Ultimo` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  `Margen_Ganancia` decimal(18, 6) NOT NULL DEFAULT '0.000000',
  PRIMARY KEY (`Producto_ID`),
  UNIQUE KEY `SKU_Codigo` (`SKU_Codigo`),
  KEY `IDX_Productos_Categoria` (`Categoria_ID`),
  CONSTRAINT `FK_Productos_Categorias` FOREIGN KEY (`Categoria_ID`) REFERENCES `categorias` (`Categoria_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 63 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `proveedores` (
  `Proveedor_ID` int NOT NULL AUTO_INCREMENT,
  `RIF_Cedula` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Razon_Social` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Telefono` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Email` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Direccion` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Activo` tinyint(1) NOT NULL DEFAULT '1',
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Proveedor_ID`),
  UNIQUE KEY `RIF_Cedula` (`RIF_Cedula`)
) ENGINE = InnoDB AUTO_INCREMENT = 6 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `tasas_bcv` (
  `Tasa_ID` int NOT NULL AUTO_INCREMENT,
  `Fecha` date NOT NULL,
  `Tasa` decimal(18, 6) NOT NULL,
  `Origen` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Banco Central de Venezuela',
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Tasa_ID`),
  UNIQUE KEY `UQ_TasasBcv_Fecha` (`Fecha`)
) ENGINE = InnoDB AUTO_INCREMENT = 4 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `usuarios` (
  `Usuario_ID` int NOT NULL AUTO_INCREMENT,
  `Nombre` varchar(180) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Credencial` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Rol` enum('CAJERO', 'SUPERVISOR', 'ADMIN') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'CAJERO',
  `Activo` tinyint(1) NOT NULL DEFAULT '1',
  `Fecha_Registro` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `PIN_Operaciones` varchar(60) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`Usuario_ID`),
  UNIQUE KEY `Credencial` (`Credencial`),
  KEY `IDX_Usuarios_Rol` (`Rol`)
) ENGINE = InnoDB AUTO_INCREMENT = 4 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `variante_atributos` (
  `Atributo_ID` int NOT NULL AUTO_INCREMENT,
  `Variante_ID` int NOT NULL,
  `Atributo` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Valor` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`Atributo_ID`),
  UNIQUE KEY `UQ_VarAttr` (`Variante_ID`, `Atributo`),
  KEY `IDX_VarAttr_Variante` (`Variante_ID`),
  CONSTRAINT `FK_VarAttr_Variante` FOREIGN KEY (`Variante_ID`) REFERENCES `producto_variantes` (`Variante_ID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB AUTO_INCREMENT = 39 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
