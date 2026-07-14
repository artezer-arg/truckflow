-- ==========================================================
-- SCRIPT DE BASE DE DATOS: TruckFlow v2
-- Sistema de visualización de avance de carga de camiones
-- Soporte para SQL Server (MSSQL)
-- ==========================================================

-- 1. TABLAS DEL SISTEMA TRUCKFLOW

-- Tabla: TruckFlow_Parametros
-- Almacena parámetros globales de configuración del dashboard
IF OBJECT_ID('TruckFlow_Parametros', 'U') IS NULL
BEGIN
    CREATE TABLE TruckFlow_Parametros (
        IdParametro INT IDENTITY(1,1) PRIMARY KEY,
        NombreParametro VARCHAR(100) UNIQUE NOT NULL,
        ValorParametro VARCHAR(1000) NOT NULL,
        Descripcion VARCHAR(500) NULL,
        FechaModificacion DATETIME DEFAULT GETDATE(),
        UsuarioModificacion VARCHAR(100) DEFAULT 'SYSTEM'
    );
END;

-- Tabla: TruckFlow_Camion
-- Registra los datos principales de los camiones (activos e históricos)
IF OBJECT_ID('TruckFlow_Camion', 'U') IS NULL
BEGIN
    CREATE TABLE TruckFlow_Camion (
        IdCamion INT IDENTITY(1,1) PRIMARY KEY,
        Fecha DATE NOT NULL,
        Turno VARCHAR(50) NOT NULL,
        SecuenciaInicialTechos INT NOT NULL,
        SecuenciaFinalTechos INT NOT NULL,
        SecuenciaInicialPaneles INT NOT NULL,
        SecuenciaFinalPaneles INT NOT NULL,
        SecuenciaInicialAsientos INT NOT NULL,
        SecuenciaFinalAsientos INT NOT NULL,
        SecuenciaInicialFiltros INT NOT NULL,
        SecuenciaFinalFiltros INT NOT NULL,
        HoraInicio DATETIME NOT NULL,
        HoraFin DATETIME NULL,
        Estado VARCHAR(50) NOT NULL DEFAULT 'Cargando', -- 'Cargando', 'Finalizado'
        TiempoMaximoMinutos INT NOT NULL DEFAULT 28,
        Demorado BIT NOT NULL DEFAULT 0, -- 0 = No demorado, 1 = Demorado
        FechaCreacion DATETIME DEFAULT GETDATE()
    );
END;

-- Tabla: TruckFlow_CamionDetalle
-- Almacena el avance acumulado por producto para cada camión
IF OBJECT_ID('TruckFlow_CamionDetalle', 'U') IS NULL
BEGIN
    CREATE TABLE TruckFlow_CamionDetalle (
        IdDetalle INT IDENTITY(1,1) PRIMARY KEY,
        IdCamion INT NOT NULL FOREIGN KEY REFERENCES TruckFlow_Camion(IdCamion) ON DELETE CASCADE,
        Producto VARCHAR(100) NOT NULL,
        CantidadEsperada INT NOT NULL,
        CantidadCargada INT NOT NULL DEFAULT 0,
        Estado VARCHAR(50) NOT NULL DEFAULT 'Pendiente', -- 'Pendiente', 'Completo'
        FechaUltimaCarga DATETIME NULL
    );
END;

-- Tabla: TruckFlow_EventoCarga
-- Guarda cada registro individual de pieza cargada para trazabilidad
IF OBJECT_ID('TruckFlow_EventoCarga', 'U') IS NULL
BEGIN
    CREATE TABLE TruckFlow_EventoCarga (
        IdEvento INT IDENTITY(1,1) PRIMARY KEY,
        IdCamion INT NOT NULL FOREIGN KEY REFERENCES TruckFlow_Camion(IdCamion) ON DELETE CASCADE,
        Producto VARCHAR(100) NOT NULL,
        SecuenciaTASA INT NOT NULL,
        Modelo VARCHAR(100) NOT NULL,
        FechaHoraCarga DATETIME NOT NULL,
        TablaOrigen VARCHAR(100) NOT NULL,
        Estado VARCHAR(50) DEFAULT 'Cargado'
    );
END;


-- 2. TABLAS EJEMPLO DE DESPACHO (Simulan las tablas de planta de las que leemos)

IF OBJECT_ID('Despacho_Techos', 'U') IS NULL
BEGIN
    CREATE TABLE Despacho_Techos (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SecuenciaTASA INT NOT NULL,
        Modelo VARCHAR(100) NOT NULL,
        FechaHoraCarga DATETIME DEFAULT GETDATE()
    );
END;

IF OBJECT_ID('Despacho_Asientos_Paneles', 'U') IS NULL
BEGIN
    CREATE TABLE Despacho_Asientos_Paneles (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        TipoProducto VARCHAR(20) NOT NULL, -- 'Panel' o 'Asiento'
        SecuenciaTASA INT NOT NULL,
        Modelo VARCHAR(100) NOT NULL,
        FechaHoraCarga DATETIME DEFAULT GETDATE()
    );
END;

IF OBJECT_ID('Despacho_Filtros', 'U') IS NULL
BEGIN
    CREATE TABLE Despacho_Filtros (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SecuenciaTASA INT NOT NULL,
        Modelo VARCHAR(100) NOT NULL,
        FechaHoraCarga DEFAULT GETDATE()
    );
END;


-- 3. VISTA UNIFICADA DE CARGAS (vw_TruckFlow_Cargas_Unificadas)
-- Esta vista une las distintas tablas para consumo de la aplicación

IF OBJECT_ID('vw_TruckFlow_Cargas_Unificadas', 'V') IS NOT NULL
BEGIN
    DROP VIEW vw_TruckFlow_Cargas_Unificadas;
END;
GO

CREATE VIEW vw_TruckFlow_Cargas_Unificadas AS
SELECT 
    'Techos' AS Producto,
    SecuenciaTASA,
    Modelo,
    FechaHoraCarga,
    'Despacho_Techos' AS TablaOrigen
FROM Despacho_Techos
UNION ALL
SELECT 
    'Paneles' AS Producto,
    SecuenciaTASA,
    Modelo,
    FechaHoraCarga,
    'Despacho_Asientos_Paneles' AS TablaOrigen
FROM Despacho_Asientos_Paneles
WHERE TipoProducto = 'Panel'
UNION ALL
SELECT 
    'Asientos' AS Producto,
    SecuenciaTASA,
    Modelo,
    FechaHoraCarga,
    'Despacho_Asientos_Paneles' AS TablaOrigen
FROM Despacho_Asientos_Paneles
WHERE TipoProducto = 'Asiento'
UNION ALL
SELECT 
    'Filtros de aire' AS Producto,
    SecuenciaTASA,
    Modelo,
    FechaHoraCarga,
    'Despacho_Filtros' AS TablaOrigen
FROM Despacho_Filtros;
GO


-- 4. INSERCIÓN DE PARÁMETROS INICIALES POR DEFECTO

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'SecuenciaInicial_Techos')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('SecuenciaInicial_Techos', '100', 'Secuencia TASA inicial para Techos');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'SecuenciaInicial_Paneles')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('SecuenciaInicial_Paneles', '120', 'Secuencia TASA inicial para Paneles');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'SecuenciaInicial_Asientos')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('SecuenciaInicial_Asientos', '100', 'Secuencia TASA inicial para Asientos');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'SecuenciaInicial_Filtros')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('SecuenciaInicial_Filtros', '098', 'Secuencia TASA inicial para Filtros de aire');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'Techos_Esperados')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('Techos_Esperados', '12', 'Cantidad esperada de techos para el camión');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'Paneles_Esperados')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('Paneles_Esperados', '24', 'Cantidad esperada de paneles para el camión');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'Asientos_Esperados')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('Asientos_Esperados', '24', 'Cantidad esperada de asientos para el camión');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'Filtros_Esperados')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('Filtros_Esperados', '24', 'Cantidad esperada de filtros de aire para el camión');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'TiempoMaximoCargaMinutos')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('TiempoMaximoCargaMinutos', '28', 'Tiempo máximo permitido antes de marcar demora');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'FrecuenciaActualizacionSegundos')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('FrecuenciaActualizacionSegundos', '300', 'Frecuencia de consulta a base de datos (segundos)');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'AvanceAutomatico')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('AvanceAutomatico', 'true', 'Activa o desactiva el avance automático de secuencia al completar el camión');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'Turnos')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('Turnos', '[{"nombre":"Turno 1 (Mañana)","inicio":"06:00","fin":"14:00"},{"nombre":"Turno 2 (Tarde)","inicio":"14:00","fin":"22:00"},{"nombre":"Turno 3 (Noche)","inicio":"22:00","fin":"06:00"}]', 'Definición de turnos de planta');

IF NOT EXISTS (SELECT 1 FROM TruckFlow_Parametros WHERE NombreParametro = 'ModoSimulador')
    INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion)
    VALUES ('ModoSimulador', 'true', 'Habilita la simulación automática de carga para pruebas rápidas');
