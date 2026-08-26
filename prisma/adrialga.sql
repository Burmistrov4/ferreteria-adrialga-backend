-- ============================================================
-- BASE DE DATOS: FERRETERÍA ADRIALGA C.A. (PREPARADA PARA BI)
-- ============================================================

-- 1. TABLA CATEGORIAS
CREATE TABLE Categorias (
    Categoria_ID INT AUTO_INCREMENT PRIMARY KEY,
    Nombre VARCHAR(100) NOT NULL,
    Activo BOOLEAN NOT NULL DEFAULT TRUE,
    Fecha_Registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. TABLA PRODUCTOS
CREATE TABLE Productos (
    Producto_ID INT AUTO_INCREMENT PRIMARY KEY,
    SKU_Codigo VARCHAR(50) NOT NULL UNIQUE,
    Nombre VARCHAR(150) NOT NULL,
    Precio_Venta DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    Costo_Promedio DECIMAL(18, 2) NOT NULL DEFAULT 0.00, -- Necesario para BI (Valoración de Inventario)
    Stock_Actual INT NOT NULL DEFAULT 0,
    Stock_Minimo INT NOT NULL DEFAULT 5,                 -- Necesario para BI (Alertas de Reabastecimiento)
    Categoria_ID INT NOT NULL,
    Activo BOOLEAN NOT NULL DEFAULT TRUE,
    Fecha_Registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_Productos_Categorias FOREIGN KEY (Categoria_ID) 
        REFERENCES Categorias(Categoria_ID) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- 3. TABLA PROVEEDORES
CREATE TABLE Proveedores (
    Proveedor_ID INT AUTO_INCREMENT PRIMARY KEY,
    RIF_Cedula VARCHAR(20) NOT NULL UNIQUE,
    Razon_Social VARCHAR(150) NOT NULL,
    Telefono VARCHAR(20),
    Email VARCHAR(100),
    Direccion VARCHAR(255),
    Activo BOOLEAN NOT NULL DEFAULT TRUE,
    Fecha_Registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. TABLA USUARIOS
CREATE TABLE Usuarios (
    Usuario_ID INT AUTO_INCREMENT PRIMARY KEY,
    Nombre VARCHAR(180) NOT NULL,
    Credencial VARCHAR(50) NOT NULL UNIQUE,
    Password VARCHAR(255) NOT NULL,
    Rol VARCHAR(30) NOT NULL DEFAULT 'Cajero',           -- Reemplaza la tabla Roles
    Activo BOOLEAN NOT NULL DEFAULT TRUE,
    Fecha_Registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. TABLA CLIENTES
CREATE TABLE Clientes (
    Cliente_ID INT AUTO_INCREMENT PRIMARY KEY,
    RIF_Cedula VARCHAR(20) NOT NULL UNIQUE,
    Razon_Social VARCHAR(150) NOT NULL,
    Direccion VARCHAR(255),
    Telefono VARCHAR(20),
    Email VARCHAR(100),
    Fecha_Registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- MÓDULO DE REABASTECIMIENTO Y ENTRADAS (NOTAS DE ENTREGA)
-- ============================================================

-- 6. TABLA NOTAS DE ENTREGA (CABECERA)
CREATE TABLE Notas_Entrega_Entrada (
    Nota_ID INT AUTO_INCREMENT PRIMARY KEY,
    Numero_Nota VARCHAR(50) NOT NULL UNIQUE,
    Fecha_Recepcion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    Total_Costo DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    Estatus VARCHAR(20) NOT NULL DEFAULT 'Procesada',     -- Procesada, Anulada
    Proveedor_ID INT NOT NULL,
    Usuario_ID INT NOT NULL,
    CONSTRAINT FK_Notas_Proveedores FOREIGN KEY (Proveedor_ID) 
        REFERENCES Proveedores(Proveedor_ID) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT FK_Notas_Usuarios FOREIGN KEY (Usuario_ID) 
        REFERENCES Usuarios(Usuario_ID) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- 7. TABLA DETALLE DE NOTAS DE ENTREGA
CREATE TABLE Detalle_Notas_Entrega (
    Detalle_Nota_ID INT AUTO_INCREMENT PRIMARY KEY,
    Nota_ID INT NOT NULL,
    Producto_ID INT NOT NULL,
    Cantidad INT NOT NULL CHECK (Cantidad > 0),
    Costo_Unitario DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    Subtotal_Costo DECIMAL(18, 2) GENERATED ALWAYS AS (Cantidad * Costo_Unitario) STORED,
    CONSTRAINT FK_DetalleNota_Cabecera FOREIGN KEY (Nota_ID) 
        REFERENCES Notas_Entrega_Entrada(Nota_ID) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT FK_DetalleNota_Productos FOREIGN KEY (Producto_ID) 
        REFERENCES Productos(Producto_ID) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- ============================================================
-- MÓDULO TRANSACCIONAL Y VENTAS (FACTURACIÓN)
-- ============================================================

-- 8. TABLA FACTURAS (CABECERA)
CREATE TABLE Facturas (
    Factura_ID INT AUTO_INCREMENT PRIMARY KEY,
    Numero_Control VARCHAR(50) UNIQUE,
    Fecha_Emision TIMESTAMP DEFAULT CURRENT_TIMESTAMP,    -- Clave para series temporales en BI
    Subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    Total_IVA DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    Total_General DECIMAL(12, 2) GENERATED ALWAYS AS (Subtotal + Total_IVA) STORED,
    Estatus VARCHAR(20) NOT NULL DEFAULT 'Completada',     -- Completada, Anulada
    Cliente_ID INT NOT NULL,
    Usuario_ID INT NOT NULL,
    CONSTRAINT FK_Facturas_Clientes FOREIGN KEY (Cliente_ID) 
        REFERENCES Clientes(Cliente_ID) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT FK_Facturas_Usuarios FOREIGN KEY (Usuario_ID) 
        REFERENCES Usuarios(Usuario_ID) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- 9. TABLA DETALLE FACTURAS
CREATE TABLE Detalle_Facturas (
    Detalle_ID INT AUTO_INCREMENT PRIMARY KEY,
    Factura_ID INT NOT NULL,
    Producto_ID INT NOT NULL,
    Cantidad INT NOT NULL CHECK (Cantidad > 0),
    Precio_Unitario DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    Costo_Unitario_Historico DECIMAL(18, 2) NOT NULL DEFAULT 0.00, -- Vital para BI (Rentabilidad real)
    Subtotal DECIMAL(12, 2) GENERATED ALWAYS AS (Cantidad * Precio_Unitario) STORED,
    CONSTRAINT FK_DetalleFactura_Facturas FOREIGN KEY (Factura_ID) 
        REFERENCES Facturas(Factura_ID) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT FK_DetalleFactura_Productos FOREIGN KEY (Producto_ID) 
        REFERENCES Productos(Producto_ID) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- 10. TABLA PAGOS
CREATE TABLE Pagos (
    Pago_ID INT AUTO_INCREMENT PRIMARY KEY,
    Factura_ID INT NOT NULL,
    Metodo_Pago VARCHAR(50) NOT NULL,                    -- Efectivo, Punto, Divisas, Pago Móvil
    Monto DECIMAL(12, 2) NOT NULL,
    Referencia VARCHAR(50),
    Fecha_Pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT FK_Pagos_Facturas FOREIGN KEY (Factura_ID) 
        REFERENCES Facturas(Factura_ID) ON UPDATE CASCADE ON DELETE CASCADE
);

-- ============================================================
-- ÍNDICES PARA OPTIMIZACIÓN DE CONSULTAS Y ANALÍTICA (BI)
-- ============================================================

CREATE INDEX IDX_Facturas_Fecha ON Facturas(Fecha_Emision);
CREATE INDEX IDX_Notas_Fecha ON Notas_Entrega_Entrada(Fecha_Recepcion);
CREATE INDEX IDX_DetalleFacturas_Producto ON Detalle_Facturas(Producto_ID);
CREATE INDEX IDX_DetalleNotas_Producto ON Detalle_Notas_Entrega(Producto_ID);
CREATE INDEX IDX_Productos_Categoria ON Productos(Categoria_ID);