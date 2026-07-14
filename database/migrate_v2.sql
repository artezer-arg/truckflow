-- ==========================================================
-- SCRIPT DE MIGRACIÓN: TruckFlow v2
-- Ejecutar en SQL Server para actualizar el esquema
-- ==========================================================

-- 1. MODIFICAR TABLA TruckFlow_Camion
-- Agregar las nuevas columnas para secuencias independientes por producto
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('TruckFlow_Camion') AND name = 'SecuenciaInicialTechos')
BEGIN
    ALTER TABLE TruckFlow_Camion ADD
        SecuenciaInicialTechos INT NULL,
        SecuenciaFinalTechos INT NULL,
        SecuenciaInicialPaneles INT NULL,
        SecuenciaFinalPaneles INT NULL,
        SecuenciaInicialAsientos INT NULL,
        SecuenciaFinalAsientos INT NULL,
        SecuenciaInicialFiltros INT NULL,
        SecuenciaFinalFiltros INT NULL;
END;
GO

-- Migrar datos anteriores si existen (opcional/mejor esfuerzo)
UPDATE TruckFlow_Camion
SET 
    SecuenciaInicialTechos = SecuenciaInicial,
    SecuenciaFinalTechos = SecuenciaFinal,
    SecuenciaInicialPaneles = SecuenciaInicial,
    SecuenciaFinalPaneles = SecuenciaFinal,
    SecuenciaInicialAsientos = SecuenciaInicial,
    SecuenciaFinalAsientos = SecuenciaFinal,
    SecuenciaInicialFiltros = SecuenciaInicial,
    SecuenciaFinalFiltros = SecuenciaFinal
WHERE SecuenciaInicialTechos IS NULL AND EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('TruckFlow_Camion') AND name = 'SecuenciaInicial'
);
GO

-- Eliminar columnas anteriores redundantes
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('TruckFlow_Camion') AND name = 'SecuenciaInicial')
BEGIN
    ALTER TABLE TruckFlow_Camion DROP COLUMN SecuenciaInicial, SecuenciaFinal;
END;
GO

-- Hacer las columnas NOT NULL después de migrar
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaInicialTechos INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaFinalTechos INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaInicialPaneles INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaFinalPaneles INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaInicialAsientos INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaFinalAsientos INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaInicialFiltros INT NOT NULL;
ALTER TABLE TruckFlow_Camion ALTER COLUMN SecuenciaFinalFiltros INT NOT NULL;
GO


-- 2. MODIFICAR TABLA TruckFlow_Parametros
-- Insertar parámetros independientes por producto

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

-- Borrar el parámetro anterior unificado si existe
DELETE FROM TruckFlow_Parametros WHERE NombreParametro = 'SecuenciaInicialActual';
GO
