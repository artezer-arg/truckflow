const fs = require('fs');
const path = require('path');
const sql = require('mssql');
require('dotenv').config();

let useSimulator = process.env.SIMULATOR_MODE === 'true';
const localDbPath = path.join(__dirname, 'local_db.json');

// Configuración de SQL Server
const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT || '1433'),
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
    }
};

let dbPool = null;

// Verifica y crea las tablas del sistema de TruckFlow si no existen
async function ensureSqlTablesExist(pool) {
    try {
        const check = await pool.request().query("SELECT OBJECT_ID('TruckFlow_Camion', 'U') as id");
        if (check.recordset[0].id === null) {
            console.log("🛠️ Creando tablas del sistema TruckFlow en SQL Server...");
            
            // Crear TruckFlow_Parametros
            await pool.request().query(`
                CREATE TABLE TruckFlow_Parametros (
                    IdParametro INT IDENTITY(1,1) PRIMARY KEY,
                    NombreParametro VARCHAR(100) UNIQUE NOT NULL,
                    ValorParametro VARCHAR(1000) NOT NULL,
                    Descripcion VARCHAR(500) NULL,
                    FechaModificacion DATETIME DEFAULT GETDATE(),
                    UsuarioModificacion VARCHAR(100) DEFAULT 'SYSTEM'
                )
            `);
            
            // Crear TruckFlow_Camion
            await pool.request().query(`
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
                    Estado VARCHAR(50) NOT NULL DEFAULT 'Cargando',
                    TiempoMaximoMinutos INT NOT NULL DEFAULT 28,
                    Demorado BIT NOT NULL DEFAULT 0,
                    FechaCreacion DATETIME DEFAULT GETDATE()
                )
            `);

            // Crear TruckFlow_CamionDetalle
            await pool.request().query(`
                CREATE TABLE TruckFlow_CamionDetalle (
                    IdDetalle INT IDENTITY(1,1) PRIMARY KEY,
                    IdCamion INT NOT NULL FOREIGN KEY REFERENCES TruckFlow_Camion(IdCamion) ON DELETE CASCADE,
                    Producto VARCHAR(100) NOT NULL,
                    CantidadEsperada INT NOT NULL,
                    CantidadCargada INT NOT NULL DEFAULT 0,
                    Estado VARCHAR(50) NOT NULL DEFAULT 'Pendiente',
                    FechaUltimaCarga DATETIME NULL
                )
            `);

            // Crear TruckFlow_EventoCarga
            await pool.request().query(`
                CREATE TABLE TruckFlow_EventoCarga (
                    IdEvento INT IDENTITY(1,1) PRIMARY KEY,
                    IdCamion INT NOT NULL FOREIGN KEY REFERENCES TruckFlow_Camion(IdCamion) ON DELETE CASCADE,
                    Producto VARCHAR(100) NOT NULL,
                    SecuenciaTASA INT NOT NULL,
                    Modelo VARCHAR(100) NOT NULL,
                    FechaHoraCarga DATETIME NOT NULL,
                    TablaOrigen VARCHAR(100) NOT NULL,
                    Estado VARCHAR(50) DEFAULT 'Cargado'
                )
            `);

            // Crear Despacho_Techos para mantener Techos en modo simulado en SQL Server
            await pool.request().query(`
                CREATE TABLE Despacho_Techos (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SecuenciaTASA INT NOT NULL,
                    Modelo VARCHAR(100) NOT NULL,
                    FechaHoraCarga DATETIME DEFAULT GETDATE()
                )
            `);

            // Insertar parámetros iniciales
            const params = [
                { k: 'SecuenciaInicial_Techos', v: '100', d: 'Secuencia TASA inicial para Techos' },
                { k: 'SecuenciaInicial_Paneles', v: '120', d: 'Secuencia TASA inicial para Paneles' },
                { k: 'SecuenciaInicial_Asientos', v: '100', d: 'Secuencia TASA inicial para Asientos' },
                { k: 'SecuenciaInicial_Filtros', v: '098', d: 'Secuencia TASA inicial para Filtros de aire' },
                { k: 'Techos_Esperados', v: '12', d: 'Cantidad esperada de techos para el camión' },
                { k: 'Paneles_Esperados', v: '24', d: 'Cantidad esperada de paneles para el camión' },
                { k: 'Asientos_Esperados', v: '24', d: 'Cantidad esperada de asientos para el camión' },
                { k: 'Filtros_Esperados', v: '24', d: 'Cantidad esperada de filtros de aire para el camión' },
                { k: 'TiempoMaximoCargaMinutos', v: '28', d: 'Tiempo máximo permitido antes de marcar demora' },
                { k: 'FrecuenciaActualizacionSegundos', v: '300', d: 'Frecuencia de consulta a base de datos (segundos)' },
                { k: 'AvanceAutomatico', v: 'true', d: 'Activa o desactiva el avance automático' },
                { k: 'ModoSimulador', v: 'true', d: 'Habilita la simulación automática' }
            ];

            for (const p of params) {
                await pool.request()
                    .input('k', sql.VarChar(100), p.k)
                    .input('v', sql.VarChar(1000), p.v)
                    .input('d', sql.VarChar(500), p.d)
                    .query("INSERT INTO TruckFlow_Parametros (NombreParametro, ValorParametro, Descripcion) VALUES (@k, @v, @d)");
            }

            console.log("✅ Tablas del sistema TruckFlow inicializadas con éxito en SQL Server.");
        }
    } catch (err) {
        console.error("❌ Error al verificar/crear las tablas de TruckFlow:", err.message);
    }
}

// Inicializa la conexión a SQL Server si no estamos en modo simulador
async function getPool() {
    if (useSimulator) return null;
    if (dbPool) return dbPool;

    if (!process.env.DB_DATABASE) {
        console.warn("⚠️ Advertencia: No se especificó DB_DATABASE en el archivo .env. Usando base de datos JSON local.");
        return null;
    }

    try {
        console.log(`🔌 Conectando a SQL Server en ${sqlConfig.server}:${sqlConfig.port}...`);
        dbPool = await sql.connect(sqlConfig);
        console.log("✅ Conexión establecida con SQL Server.");
        await ensureSqlTablesExist(dbPool);
        return dbPool;
    } catch (err) {
        console.error("❌ Error de conexión a SQL Server:", err.message);
        console.log("⚠️ Fallback: Usando base de datos JSON local.");
        return null;
    }
}

// LÓGICA DE BASE DE DATOS JSON LOCAL (MIGRACIÓN AUTO-HEALING V2)
function initLocalDb() {
    let resetNeeded = false;
    
    if (fs.existsSync(localDbPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(localDbPath, 'utf8'));
            // Si la base de datos local vieja no tiene los parámetros de secuencias independientes de v2, la reseteamos
            if (!data.TruckFlow_Parametros.some(p => p.NombreParametro === 'SecuenciaInicial_Techos')) {
                console.log("🔄 Migración de BD JSON local a v2 detectada. Reseteando archivo de datos...");
                resetNeeded = true;
            }
        } catch (e) {
            resetNeeded = true;
        }
    } else {
        resetNeeded = true;
    }

    if (resetNeeded) {
        const defaultDb = {
            TruckFlow_Parametros: [
                { NombreParametro: "SecuenciaInicial_Techos", ValorParametro: "100", Descripcion: "Secuencia TASA inicial para Techos" },
                { NombreParametro: "SecuenciaInicial_Paneles", ValorParametro: "120", Descripcion: "Secuencia TASA inicial para Paneles" },
                { NombreParametro: "SecuenciaInicial_Asientos", ValorParametro: "100", Descripcion: "Secuencia TASA inicial para Asientos" },
                { NombreParametro: "SecuenciaInicial_Filtros", ValorParametro: "098", Descripcion: "Secuencia TASA inicial para Filtros de aire" },
                { NombreParametro: "Techos_Esperados", ValorParametro: "12", Descripcion: "Cantidad esperada de techos para el camión" },
                { NombreParametro: "Paneles_Esperados", ValorParametro: "24", Descripcion: "Cantidad esperada de paneles para el camión" },
                { NombreParametro: "Asientos_Esperados", ValorParametro: "24", Descripcion: "Cantidad esperada de asientos para el camión" },
                { NombreParametro: "Filtros_Esperados", ValorParametro: "24", Descripcion: "Cantidad esperada de filtros de aire para el camión" },
                { NombreParametro: "TiempoMaximoCargaMinutos", ValorParametro: "28", Descripcion: "Tiempo máximo permitido antes de marcar demora" },
                { NombreParametro: "FrecuenciaActualizacionSegundos", ValorParametro: "300", Descripcion: "Frecuencia de consulta a base de datos (segundos)" },
                { NombreParametro: "AvanceAutomatico", ValorParametro: "true", Descripcion: "Activa o desactiva el avance automático" },
                { NombreParametro: "Turnos", ValorParametro: '[{"nombre":"Turno 1 (Mañana)","inicio":"06:00","fin":"14:00"},{"nombre":"Turno 2 (Tarde)","inicio":"14:00","fin":"22:00"},{"nombre":"Turno 3 (Noche)","inicio":"22:00","fin":"06:00"}]', Descripcion: "Definición de turnos de planta" },
                { NombreParametro: "ModoSimulador", ValorParametro: "true", Descripcion: "Habilita la simulación automática" }
            ],
            TruckFlow_Camion: [],
            TruckFlow_CamionDetalle: [],
            TruckFlow_EventoCarga: [],
            Despacho_Techos: [],
            Despacho_Asientos_Paneles: [],
            Despacho_Filtros: []
        };
        fs.writeFileSync(localDbPath, JSON.stringify(defaultDb, null, 2), 'utf8');
    }
}

function readLocalDb() {
    initLocalDb();
    const data = fs.readFileSync(localDbPath, 'utf8');
    return JSON.parse(data);
}

function writeLocalDb(data) {
    fs.writeFileSync(localDbPath, JSON.stringify(data, null, 2), 'utf8');
}

// ----------------------------------------------------
// METODOS DEL CONECTOR DE BASE DE DATOS TRUCKFLOW V2
// ----------------------------------------------------

const db = {
    // 1. GESTION DE PARAMETROS
    async getParametros() {
        const pool = await getPool();
        if (pool) {
            const res = await pool.request().query("SELECT NombreParametro, ValorParametro, Descripcion FROM TruckFlow_Parametros");
            return res.recordset;
        } else {
            const localData = readLocalDb();
            return localData.TruckFlow_Parametros;
        }
    },

    async getParametro(nombre) {
        const pool = await getPool();
        if (pool) {
            const res = await pool.request()
                .input('nombre', sql.VarChar(100), nombre)
                .query("SELECT ValorParametro FROM TruckFlow_Parametros WHERE NombreParametro = @nombre");
            return res.recordset[0] ? res.recordset[0].ValorParametro : null;
        } else {
            const localData = readLocalDb();
            const param = localData.TruckFlow_Parametros.find(p => p.NombreParametro === nombre);
            return param ? param.ValorParametro : null;
        }
    },

    async setParametro(nombre, valor) {
        const pool = await getPool();
        if (pool) {
            await pool.request()
                .input('nombre', sql.VarChar(100), nombre)
                .input('valor', sql.VarChar(1000), String(valor))
                .query("UPDATE TruckFlow_Parametros SET ValorParametro = @valor, FechaModificacion = GETDATE() WHERE NombreParametro = @nombre");
        } else {
            const localData = readLocalDb();
            const paramIndex = localData.TruckFlow_Parametros.findIndex(p => p.NombreParametro === nombre);
            if (paramIndex !== -1) {
                localData.TruckFlow_Parametros[paramIndex].ValorParametro = String(valor);
            } else {
                localData.TruckFlow_Parametros.push({ NombreParametro: nombre, ValorParametro: String(valor), Descripcion: '' });
            }
            writeLocalDb(localData);
        }
    },

    // 2. GESTION DE CAMION ACTIVO
    async getCamionActivo() {
        const pool = await getPool();
        if (pool) {
            const res = await pool.request().query("SELECT TOP 1 * FROM TruckFlow_Camion WHERE Estado = 'Cargando' ORDER BY IdCamion DESC");
            return res.recordset[0] || null;
        } else {
            const localData = readLocalDb();
            const camion = localData.TruckFlow_Camion.find(c => c.Estado === 'Cargando');
            return camion || null;
        }
    },

    async crearCamionActivo(fecha, turno, seqs, techos, paneles, asientos, filtros, tiempoMax) {
        const pool = await getPool();
        const now = new Date();
        
        if (pool) {
            const res = await pool.request()
                .input('fecha', sql.Date, fecha)
                .input('turno', sql.VarChar(50), turno)
                .input('initTechos', sql.Int, seqs.techos.inicial)
                .input('endTechos', sql.Int, seqs.techos.final)
                .input('initPaneles', sql.Int, seqs.paneles.inicial)
                .input('endPaneles', sql.Int, seqs.paneles.final)
                .input('initAsientos', sql.Int, seqs.asientos.inicial)
                .input('endAsientos', sql.Int, seqs.asientos.final)
                .input('initFiltros', sql.Int, seqs.filtros.inicial)
                .input('endFiltros', sql.Int, seqs.filtros.final)
                .input('horaInicio', sql.DateTime, now)
                .input('tiempoMax', sql.Int, tiempoMax)
                .query(`
                    INSERT INTO TruckFlow_Camion (
                        Fecha, Turno, 
                        SecuenciaInicialTechos, SecuenciaFinalTechos,
                        SecuenciaInicialPaneles, SecuenciaFinalPaneles,
                        SecuenciaInicialAsientos, SecuenciaFinalAsientos,
                        SecuenciaInicialFiltros, SecuenciaFinalFiltros,
                        HoraInicio, Estado, TiempoMaximoMinutos, Demorado, FechaCreacion
                    )
                    OUTPUT INSERTED.IdCamion
                    VALUES (
                        @fecha, @turno, 
                        @initTechos, @endTechos,
                        @initPaneles, @endPaneles,
                        @initAsientos, @endAsientos,
                        @initFiltros, @endFiltros,
                        @horaInicio, 'Cargando', @tiempoMax, 0, GETDATE()
                    )
                `);
            const idCamion = res.recordset[0].IdCamion;
            
            // Insertar detalles iniciales
            const productos = [
                { nombre: 'Techos', esperado: techos },
                { nombre: 'Paneles', esperado: paneles },
                { nombre: 'Asientos', esperado: asientos },
                { nombre: 'Filtros de aire', esperado: filtros }
            ];

            for (const prod of productos) {
                await pool.request()
                    .input('idCamion', sql.Int, idCamion)
                    .input('producto', sql.VarChar(100), prod.nombre)
                    .input('esperado', sql.Int, prod.esperado)
                    .query(`
                        INSERT INTO TruckFlow_CamionDetalle (IdCamion, Producto, CantidadEsperada, CantidadCargada, Estado)
                        VALUES (@idCamion, @producto, @esperado, 0, 'Pendiente')
                    `);
            }
            
            return idCamion;
        } else {
            const localData = readLocalDb();
            const idCamion = localData.TruckFlow_Camion.length + 1;
            const nuevoCamion = {
                IdCamion: idCamion,
                Fecha: fecha,
                Turno: turno,
                SecuenciaInicialTechos: seqs.techos.inicial,
                SecuenciaFinalTechos: seqs.techos.final,
                SecuenciaInicialPaneles: seqs.paneles.inicial,
                SecuenciaFinalPaneles: seqs.paneles.final,
                SecuenciaInicialAsientos: seqs.asientos.inicial,
                SecuenciaFinalAsientos: seqs.asientos.final,
                SecuenciaInicialFiltros: seqs.filtros.inicial,
                SecuenciaFinalFiltros: seqs.filtros.final,
                HoraInicio: now.toISOString(),
                HoraFin: null,
                Estado: 'Cargando',
                TiempoMaximoMinutos: tiempoMax,
                Demorado: false,
                FechaCreacion: now.toISOString()
            };
            localData.TruckFlow_Camion.push(nuevoCamion);

            const productos = [
                { nombre: 'Techos', esperado: techos },
                { nombre: 'Paneles', esperado: paneles },
                { nombre: 'Asientos', esperado: asientos },
                { nombre: 'Filtros de aire', esperado: filtros }
            ];

            productos.forEach(prod => {
                localData.TruckFlow_CamionDetalle.push({
                    IdDetalle: localData.TruckFlow_CamionDetalle.length + 1,
                    IdCamion: idCamion,
                    Producto: prod.nombre,
                    CantidadEsperada: prod.esperado,
                    CantidadCargada: 0,
                    Estado: 'Pendiente',
                    FechaUltimaCarga: null
                });
            });

            writeLocalDb(localData);
            return idCamion;
        }
    },

    async updateCamionActivo(idCamion, fields) {
        const pool = await getPool();
        if (pool) {
            let queryText = "UPDATE TruckFlow_Camion SET ";
            const req = pool.request().input('idCamion', sql.Int, idCamion);
            
            const sets = [];
            if (fields.Estado !== undefined) {
                req.input('estado', sql.VarChar(50), fields.Estado);
                sets.push("Estado = @estado");
            }
            if (fields.HoraFin !== undefined) {
                req.input('horaFin', sql.DateTime, fields.HoraFin ? new Date(fields.HoraFin) : null);
                sets.push("HoraFin = @horaFin");
            }
            if (fields.Demorado !== undefined) {
                req.input('demorado', sql.Bit, fields.Demorado ? 1 : 0);
                sets.push("Demorado = @demorado");
            }
            
            if (sets.length === 0) return;
            queryText += sets.join(", ") + " WHERE IdCamion = @idCamion";
            await req.query(queryText);
        } else {
            const localData = readLocalDb();
            const cam = localData.TruckFlow_Camion.find(c => c.IdCamion === idCamion);
            if (cam) {
                if (fields.Estado !== undefined) cam.Estado = fields.Estado;
                if (fields.HoraFin !== undefined) cam.HoraFin = fields.HoraFin;
                if (fields.Demorado !== undefined) cam.Demorado = fields.Demorado;
                writeLocalDb(localData);
            }
        }
    },

    // 3. GESTION DE DETALLES DEL CAMION
    async getCamionDetalles(idCamion) {
        const pool = await getPool();
        if (pool) {
            const res = await pool.request()
                .input('idCamion', sql.Int, idCamion)
                .query("SELECT * FROM TruckFlow_CamionDetalle WHERE IdCamion = @idCamion");
            return res.recordset;
        } else {
            const localData = readLocalDb();
            return localData.TruckFlow_CamionDetalle.filter(d => d.IdCamion === idCamion);
        }
    },

    async updateCamionDetalle(idCamion, producto, cantidadCargada, estado, fechaUltimaCarga) {
        const pool = await getPool();
        if (pool) {
            await pool.request()
                .input('idCamion', sql.Int, idCamion)
                .input('producto', sql.VarChar(100), producto)
                .input('cantidadCargada', sql.Int, cantidadCargada)
                .input('estado', sql.VarChar(50), estado)
                .input('fechaUltimaCarga', sql.DateTime, fechaUltimaCarga ? new Date(fechaUltimaCarga) : null)
                .query(`
                    UPDATE TruckFlow_CamionDetalle 
                    SET CantidadCargada = @cantidadCargada, Estado = @estado, FechaUltimaCarga = @fechaUltimaCarga
                    WHERE IdCamion = @idCamion AND Producto = @producto
                `);
        } else {
            const localData = readLocalDb();
            const det = localData.TruckFlow_CamionDetalle.find(d => d.IdCamion === idCamion && d.Producto === producto);
            if (det) {
                det.CantidadCargada = cantidadCargada;
                det.Estado = estado;
                det.FechaUltimaCarga = fechaUltimaCarga;
                writeLocalDb(localData);
            }
        }
    },

    // 4. EVENTOS DE CARGA REGISTRADOS
    async getEventosCarga(idCamion) {
        const pool = await getPool();
        if (pool) {
            const res = await pool.request()
                .input('idCamion', sql.Int, idCamion)
                .query("SELECT * FROM TruckFlow_EventoCarga WHERE IdCamion = @idCamion");
            return res.recordset;
        } else {
            const localData = readLocalDb();
            return localData.TruckFlow_EventoCarga.filter(e => e.IdCamion === idCamion);
        }
    },

    async insertEventoCarga(idCamion, producto, secuenciaTASA, modelo, fechaHoraCarga, tablaOrigen) {
        const pool = await getPool();
        if (pool) {
            await pool.request()
                .input('idCamion', sql.Int, idCamion)
                .input('producto', sql.VarChar(100), producto)
                .input('secuenciaTASA', sql.Int, secuenciaTASA)
                .input('modelo', sql.VarChar(100), modelo)
                .input('fechaHoraCarga', sql.DateTime, new Date(fechaHoraCarga))
                .input('tablaOrigen', sql.VarChar(100), tablaOrigen)
                .query(`
                    INSERT INTO TruckFlow_EventoCarga (IdCamion, Producto, SecuenciaTASA, Modelo, FechaHoraCarga, TablaOrigen, Estado)
                    VALUES (@idCamion, @producto, @secuenciaTASA, @modelo, @fechaHoraCarga, @tablaOrigen, 'Cargado')
                `);
        } else {
            const localData = readLocalDb();
            localData.TruckFlow_EventoCarga.push({
                IdEvento: localData.TruckFlow_EventoCarga.length + 1,
                IdCamion: idCamion,
                Producto: producto,
                SecuenciaTASA: secuenciaTASA,
                Modelo: modelo,
                FechaHoraCarga: fechaHoraCarga,
                TablaOrigen: tablaOrigen,
                Estado: 'Cargado'
            });
            writeLocalDb(localData);
        }
    },

    // 5. CONSULTA DE CARGAS REALES CON FILTROS INDEPENDIENTES DE SECUENCIAS POR PRODUCTO
    async queryCargasUnificadas(filtros) {
        const pool = await getPool();
        if (pool) {
            const req = pool.request();
            
            // 1. Asientos
            req.input('init_asientos', sql.Int, filtros.asientos.inicial);
            req.input('end_asientos', sql.Int, filtros.asientos.final);
            const rangeAsientos = filtros.asientos.inicial <= filtros.asientos.final
                ? `(Secuencia BETWEEN @init_asientos AND @end_asientos)`
                : `(Secuencia >= @init_asientos OR Secuencia <= @end_asientos)`;

            // 2. Paneles
            req.input('init_paneles', sql.Int, filtros.paneles.inicial);
            req.input('end_paneles', sql.Int, filtros.paneles.final);
            const rangePaneles = filtros.paneles.inicial <= filtros.paneles.final
                ? `(Secuencia BETWEEN @init_paneles AND @end_paneles)`
                : `(Secuencia >= @init_paneles OR Secuencia <= @end_paneles)`;

            // 3. Filtros
            req.input('init_filtros', sql.Int, filtros.filtros.inicial);
            req.input('end_filtros', sql.Int, filtros.filtros.final);
            const rangeFiltros = filtros.filtros.inicial <= filtros.filtros.final
                ? `(Secuencia BETWEEN @init_filtros AND @end_filtros)`
                : `(Secuencia >= @init_filtros OR Secuencia <= @end_filtros)`;

            // 4. Techos (Simulado)
            req.input('init_techos', sql.Int, filtros.techos.inicial);
            req.input('end_techos', sql.Int, filtros.techos.final);
            const rangeTechos = filtros.techos.inicial <= filtros.techos.final
                ? `(SecuenciaTASA BETWEEN @init_techos AND @end_techos)`
                : `(SecuenciaTASA >= @init_techos OR SecuenciaTASA <= @end_techos)`;

            const queryText = `
                WITH LatestAsientos AS (
                    SELECT Secuencia, EstadoValidacionSEAT, FechaSecuencia,
                           ROW_NUMBER() OVER(PARTITION BY Secuencia ORDER BY IdOrdenProduccion DESC) as RowNum
                    FROM [PRODUCCION].[OrdenProduccion]
                    WHERE Lector = 'H'
                ),
                LatestPaneles AS (
                    SELECT Secuencia, EstadoValidacionARMREST, FechaSecuencia,
                           ROW_NUMBER() OVER(PARTITION BY Secuencia ORDER BY IdOrdenProduccion DESC) as RowNum
                    FROM [PRODUCCION].[OrdenProduccion]
                    WHERE Lector = 'H'
                ),
                LatestFiltros AS (
                    SELECT Secuencia, EstadoValidacionFPT, FechaSecuencia,
                           ROW_NUMBER() OVER(PARTITION BY Secuencia ORDER BY IdOrdenProduccion DESC) as RowNum
                    FROM [PRODUCCION].[OrdenProduccion]
                    WHERE Lector = 'H'
                )
                
                -- Asientos
                SELECT 'Asientos' AS Producto, Secuencia AS SecuenciaTASA, 'SEAT-REAL' AS Modelo, FechaSecuencia AS FechaHoraCarga, 'OrdenProduccion' AS TablaOrigen
                FROM LatestAsientos
                WHERE RowNum = 1 AND EstadoValidacionSEAT = 2 AND ${rangeAsientos}
                
                UNION ALL
                
                -- Paneles
                SELECT 'Paneles' AS Producto, Secuencia AS SecuenciaTASA, 'ARMREST-REAL' AS Modelo, FechaSecuencia AS FechaHoraCarga, 'OrdenProduccion' AS TablaOrigen
                FROM LatestPaneles
                WHERE RowNum = 1 AND EstadoValidacionARMREST = 2 AND ${rangePaneles}
                
                UNION ALL
                
                -- Filtros de aire
                SELECT 'Filtros de aire' AS Producto, Secuencia AS SecuenciaTASA, 'FPT-REAL' AS Modelo, FechaSecuencia AS FechaHoraCarga, 'OrdenProduccion' AS TablaOrigen
                FROM LatestFiltros
                WHERE RowNum = 1 AND EstadoValidacionFPT = 2 AND ${rangeFiltros}
                
                UNION ALL
                
                -- Techos (Simulado)
                SELECT 'Techos' AS Producto, SecuenciaTASA, Modelo, FechaHoraCarga, 'Despacho_Techos' AS TablaOrigen
                FROM Despacho_Techos
                WHERE ${rangeTechos}
            `;

            const res = await req.query(queryText);
            return res.recordset;
        } else {
            const localData = readLocalDb();
            const unificadas = [];
            
            localData.Despacho_Techos.forEach(item => {
                unificadas.push({ Producto: 'Techos', SecuenciaTASA: item.SecuenciaTASA, Modelo: item.Modelo, FechaHoraCarga: item.FechaHoraCarga, TablaOrigen: 'Despacho_Techos' });
            });
            localData.Despacho_Asientos_Paneles.forEach(item => {
                if (item.TipoProducto === 'Panel') {
                    unificadas.push({ Producto: 'Paneles', SecuenciaTASA: item.SecuenciaTASA, Modelo: item.Modelo, FechaHoraCarga: item.FechaHoraCarga, TablaOrigen: 'Despacho_Asientos_Paneles' });
                } else if (item.TipoProducto === 'Asiento') {
                    unificadas.push({ Producto: 'Asientos', SecuenciaTASA: item.SecuenciaTASA, Modelo: item.Modelo, FechaHoraCarga: item.FechaHoraCarga, TablaOrigen: 'Despacho_Asientos_Paneles' });
                }
            });
            localData.Despacho_Filtros.forEach(item => {
                unificadas.push({ Producto: 'Filtros de aire', SecuenciaTASA: item.SecuenciaTASA, Modelo: item.Modelo, FechaHoraCarga: item.FechaHoraCarga, TablaOrigen: 'Despacho_Filtros' });
            });

            // Filtrar rangos independientes de secuencia en fallback JSON local
            return unificadas.filter(item => {
                const s = item.SecuenciaTASA;
                if (item.Producto === 'Techos') {
                    const { inicial, final } = filtros.techos;
                    return inicial <= final ? (s >= inicial && s <= final) : (s >= inicial || s <= final);
                }
                if (item.Producto === 'Paneles') {
                    const { inicial, final } = filtros.paneles;
                    return inicial <= final ? (s >= inicial && s <= final) : (s >= inicial || s <= final);
                }
                if (item.Producto === 'Asientos') {
                    const { inicial, final } = filtros.asientos;
                    return inicial <= final ? (s >= inicial && s <= final) : (s >= inicial || s <= final);
                }
                if (item.Producto === 'Filtros de aire') {
                    const { inicial, final } = filtros.filtros;
                    return inicial <= final ? (s >= inicial && s <= final) : (s >= inicial || s <= final);
                }
                return false;
            });
        }
    },

    // 6. HISTORIAL DE CAMIONES FINALIZADOS CON RANGOS POR PRODUCTO
    async getHistorial(fecha, turno) {
        const pool = await getPool();
        if (pool) {
            let queryText = `
                SELECT c.*, 
                       (SELECT CantidadEsperada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Techos') AS Techos_Esp,
                       (SELECT CantidadCargada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Techos') AS Techos_Real,
                       (SELECT CantidadEsperada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Paneles') AS Paneles_Esp,
                       (SELECT CantidadCargada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Paneles') AS Paneles_Real,
                       (SELECT CantidadEsperada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Asientos') AS Asientos_Esp,
                       (SELECT CantidadCargada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Asientos') AS Asientos_Real,
                       (SELECT CantidadEsperada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Filtros de aire') AS Filtros_Esp,
                       (SELECT CantidadCargada FROM TruckFlow_CamionDetalle WHERE IdCamion = c.IdCamion AND Producto = 'Filtros de aire') AS Filtros_Real
                FROM TruckFlow_Camion c
                WHERE c.Estado = 'Finalizado'
            `;
            const req = pool.request();
            if (fecha) {
                req.input('fecha', sql.Date, fecha);
                queryText += " AND c.Fecha = @fecha";
            }
            if (turno) {
                req.input('turno', sql.VarChar(50), turno);
                queryText += " AND c.Turno = @turno";
            }
            queryText += " ORDER BY c.IdCamion DESC";
            
            const res = await req.query(queryText);
            return res.recordset;
        } else {
            const localData = readLocalDb();
            const finalizados = localData.TruckFlow_Camion.filter(c => {
                let match = c.Estado === 'Finalizado';
                if (match && fecha) {
                    match = c.Fecha === fecha;
                }
                if (match && turno) {
                    match = c.Turno === turno;
                }
                return match;
            });

            return finalizados.map(c => {
                const getDet = (prod) => localData.TruckFlow_CamionDetalle.find(d => d.IdCamion === c.IdCamion && d.Producto === prod) || { CantidadEsperada: 0, CantidadCargada: 0 };
                const t = getDet('Techos');
                const p = getDet('Paneles');
                const a = getDet('Asientos');
                const f = getDet('Filtros de aire');
                
                return {
                    ...c,
                    Techos_Esp: t.CantidadEsperada,
                    Techos_Real: t.CantidadCargada,
                    Paneles_Esp: p.CantidadEsperada,
                    Paneles_Real: p.CantidadCargada,
                    Asientos_Esp: a.CantidadEsperada,
                    Asientos_Real: a.CantidadCargada,
                    Filtros_Esp: f.CantidadEsperada,
                    Filtros_Real: f.CantidadCargada
                };
            }).sort((x, y) => y.IdCamion - x.IdCamion);
        }
    },

    // 7. INSERCIONES DE SIMULACIÓN EN TABLAS DE DESPACHO MOCK (SOLO MODO SIMULADOR)
    async insertDespachoRecord(producto, secuenciaTASA, modelo, fechaHoraCarga) {
        if (useSimulator) {
            const localData = readLocalDb();
            const timestamp = fechaHoraCarga || new Date().toISOString();
            
            if (producto === 'Techos') {
                localData.Despacho_Techos.push({ SecuenciaTASA: secuenciaTASA, Modelo: modelo, FechaHoraCarga: timestamp });
            } else if (producto === 'Paneles') {
                localData.Despacho_Asientos_Paneles.push({ TipoProducto: 'Panel', SecuenciaTASA: secuenciaTASA, Modelo: modelo, FechaHoraCarga: timestamp });
            } else if (producto === 'Asientos') {
                localData.Despacho_Asientos_Paneles.push({ TipoProducto: 'Asiento', SecuenciaTASA: secuenciaTASA, Modelo: modelo, FechaHoraCarga: timestamp });
            } else if (producto === 'Filtros de aire') {
                localData.Despacho_Filtros.push({ SecuenciaTASA: secuenciaTASA, Modelo: modelo, FechaHoraCarga: timestamp });
            }
            writeLocalDb(localData);
        } else {
            const pool = await getPool();
            if (pool) {
                const timestamp = fechaHoraCarga ? new Date(fechaHoraCarga) : new Date();
                if (producto === 'Techos') {
                    await pool.request()
                        .input('sec', sql.Int, secuenciaTASA)
                        .input('model', sql.VarChar(100), modelo)
                        .input('time', sql.DateTime, timestamp)
                        .query("INSERT INTO Despacho_Techos (SecuenciaTASA, Modelo, FechaHoraCarga) VALUES (@sec, @model, @time)");
                } else if (producto === 'Paneles') {
                    await pool.request()
                        .input('sec', sql.Int, secuenciaTASA)
                        .input('model', sql.VarChar(100), modelo)
                        .input('time', sql.DateTime, timestamp)
                        .query("INSERT INTO Despacho_Asientos_Paneles (TipoProducto, SecuenciaTASA, Modelo, FechaHoraCarga) VALUES ('Panel', @sec, @model, @time)");
                } else if (producto === 'Asientos') {
                    await pool.request()
                        .input('sec', sql.Int, secuenciaTASA)
                        .input('model', sql.VarChar(100), modelo)
                        .input('time', sql.DateTime, timestamp)
                        .query("INSERT INTO Despacho_Asientos_Paneles (TipoProducto, SecuenciaTASA, Modelo, FechaHoraCarga) VALUES ('Asiento', @sec, @model, @time)");
                } else if (producto === 'Filtros de aire') {
                    await pool.request()
                        .input('sec', sql.Int, secuenciaTASA)
                        .input('model', sql.VarChar(100), modelo)
                        .input('time', sql.DateTime, timestamp)
                        .query("INSERT INTO Despacho_Filtros (SecuenciaTASA, Modelo, FechaHoraCarga) VALUES (@sec, @model, @time)");
                }
            }
        }
    },

    // 8. RESETEAR SIMULACIÓN (Vaciar las tablas mock para reiniciar el test)
    async resetMockDespachos() {
        const localData = readLocalDb();
        localData.Despacho_Techos = [];
        localData.Despacho_Asientos_Paneles = [];
        localData.Despacho_Filtros = [];
        writeLocalDb(localData);

        const pool = await getPool();
        if (pool) {
            try {
                await pool.request().query("DELETE FROM Despacho_Techos; DELETE FROM Despacho_Asientos_Paneles; DELETE FROM Despacho_Filtros;");
            } catch (err) {
                console.error("Error reseteando despacho real:", err);
            }
        }
    },

    // 9. RECONFIGURAR Y RECONECTAR LA CONEXIÓN DE SQL SERVER EN CALIENTE
    async reconfigureConnection() {
        // Recargar variables de entorno del proceso
        useSimulator = process.env.SIMULATOR_MODE === 'true';
        
        sqlConfig.user = process.env.DB_USER;
        sqlConfig.password = process.env.DB_PASSWORD;
        sqlConfig.server = process.env.DB_SERVER || 'localhost';
        sqlConfig.database = process.env.DB_DATABASE;
        sqlConfig.port = parseInt(process.env.DB_PORT || '1433');
        sqlConfig.options.encrypt = process.env.DB_ENCRYPT === 'true';
        sqlConfig.options.trustServerCertificate = process.env.DB_TRUST_SERVER_CERTIFICATE === 'true';
        
        if (dbPool) {
            console.log("🔄 Cerrando pool de conexiones SQL Server anterior...");
            try {
                await dbPool.close();
            } catch (err) {
                console.error("Error al cerrar pool anterior:", err.message);
            }
            dbPool = null;
        }
        
        console.log("🔄 Parámetros de conexión actualizados. Reintentando conectar...");
        await getPool();
    }
};

module.exports = db;
