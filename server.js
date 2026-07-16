const express = require('express');
const path = require('path');
const db = require('./database/db');
require('dotenv').config();

// CONTROL DE ERRORES GLOBAL PARA EVITAR CAÍDAS POR CAUSA DE TIMEOUTS O CAÍDAS DE RED DE SQL SERVER
process.on('uncaughtException', (err) => {
    console.error('🔥 EXCEPCIÓN NO CONTROLADA DETECTADA (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 RECHAZO DE PROMESA NO CONTROLADO DETECTADO (unhandledRejection):', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// VARIABLES DE ESTADO LOCAL DEL SERVIDOR
let syncIntervalId = null;
let simulatorIntervalId = null;
let lastSyncTime = null;
let nextSyncTime = null;

// ==========================================
// 1. FUNCIONES AUXILIARES Y DE CÁLCULO
// ==========================================

// Determina el turno de planta actual basándose en la hora
function obtenerTurnoActual() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const tiempoMinutos = hora * 60 + minutos;

    // Turno 1 (Mañana): 06:00 - 14:00 (360 a 840 minutos)
    // Turno 2 (Tarde): 14:00 - 22:00 (840 a 1320 minutos)
    // Turno 3 (Noche): 22:00 - 06:00 (1320 a 1440 o 0 a 360 minutos)
    if (tiempoMinutos >= 360 && tiempoMinutos < 840) {
        return "Turno 1 (Mañana)";
    } else if (tiempoMinutos >= 840 && tiempoMinutos < 1320) {
        return "Turno 2 (Tarde)";
    } else {
        return "Turno 3 (Noche)";
    }
}

// Formatea un número de secuencia TASA a 3 dígitos con ceros a la izquierda
function formatearSecuenciaTASA(numero) {
    return String(numero).padStart(3, '0');
}

// ==========================================
// 2. LOGICA DEL SINCRONIZADOR DE CARGA V2
// ==========================================

async function sincronizarCamionActivo() {
    lastSyncTime = new Date();
    const frecuencia = parseInt(await db.getParametro('FrecuenciaActualizacionSegundos') || '300');
    nextSyncTime = new Date(lastSyncTime.getTime() + frecuencia * 1000);

    try {
        let camion = await db.getCamionActivo();

        // Si no hay camión activo, inicializar uno nuevo en base a las 4 secuencias iniciales
        if (!camion) {
            console.log("🚚 No se encontró camión activo. Inicializando nuevo camión con secuencias independientes...");
            const initTechos = parseInt(await db.getParametro('SecuenciaInicial_Techos') || '100');
            const initPaneles = parseInt(await db.getParametro('SecuenciaInicial_Paneles') || '120');
            const initAsientos = parseInt(await db.getParametro('SecuenciaInicial_Asientos') || '100');
            const initFiltros = parseInt(await db.getParametro('SecuenciaInicial_Filtros') || '098');

            const techosEsperados = parseInt(await db.getParametro('Techos_Esperados') || '12');
            const panelesEsperados = parseInt(await db.getParametro('Paneles_Esperados') || '24');
            const asientosEsperados = parseInt(await db.getParametro('Asientos_Esperados') || '24');
            const filtrosEsperados = parseInt(await db.getParametro('Filtros_Esperados') || '24');
            
            const tiempoMax = parseInt(await db.getParametro('TiempoMaximoCargaMinutos') || '28');
            const turno = obtenerTurnoActual();
            const fechaStr = new Date().toISOString().split('T')[0];

            // Rango de secuencias calculado
            const seqs = {
                techos: { inicial: initTechos, final: (initTechos + techosEsperados - 1) % 1000 },
                paneles: { inicial: initPaneles, final: (initPaneles + 23) % 1000 },
                asientos: { inicial: initAsientos, final: (initAsientos + 23) % 1000 },
                filtros: { inicial: initFiltros, final: (initFiltros + 23) % 1000 }
            };

            await db.crearCamionActivo(fechaStr, turno, seqs, techosEsperados, panelesEsperados, asientosEsperados, filtrosEsperados, tiempoMax);
            camion = await db.getCamionActivo();
            console.log(`🚚 Nuevo camión activo creado: 
              - Techos: ${formatearSecuenciaTASA(initTechos)} a ${formatearSecuenciaTASA(seqs.techos.final)}
              - Paneles: ${formatearSecuenciaTASA(initPaneles)} a ${formatearSecuenciaTASA(seqs.paneles.final)}
              - Asientos: ${formatearSecuenciaTASA(initAsientos)} a ${formatearSecuenciaTASA(seqs.asientos.final)}
              - Filtros: ${formatearSecuenciaTASA(initFiltros)} a ${formatearSecuenciaTASA(seqs.filtros.final)}`);
        }

        const idCamion = camion.IdCamion;
        const filtros = {
            techos: { inicial: camion.SecuenciaInicialTechos, final: camion.SecuenciaFinalTechos },
            paneles: { inicial: camion.SecuenciaInicialPaneles, final: camion.SecuenciaFinalPaneles },
            asientos: { inicial: camion.SecuenciaInicialAsientos, final: camion.SecuenciaFinalAsientos },
            filtros: { inicial: camion.SecuenciaInicialFiltros, final: camion.SecuenciaFinalFiltros }
        };

        // 1. Obtener eventos de despacho reales usando rangos independientes
        const cargasReales = await db.queryCargasUnificadas(filtros);
        
        // 2. Obtener eventos ya registrados para este camión
        const eventosRegistrados = await db.getEventosCarga(idCamion);
        const setEventos = new Set(eventosRegistrados.map(e => `${e.Producto}_${e.SecuenciaTASA}`));

        // 3. Procesar cargas reales encontradas
        for (const carga of cargasReales) {
            const key = `${carga.Producto}_${carga.SecuenciaTASA}`;
            if (!setEventos.has(key)) {
                console.log(`🆕 Nueva pieza cargada detectada: ${carga.Producto} Secuencia ${formatearSecuenciaTASA(carga.SecuenciaTASA)} (${carga.Modelo})`);
                await db.insertEventoCarga(idCamion, carga.Producto, carga.SecuenciaTASA, carga.Modelo, carga.FechaHoraCarga, carga.TablaOrigen);
                setEventos.add(key);
            }
        }

        // 4. Recalcular contadores y actualizar detalles de camión
        const eventosActualizados = await db.getEventosCarga(idCamion);
        const detalles = await db.getCamionDetalles(idCamion);

        let todosCompletos = true;

        for (const det of detalles) {
            const cargasProducto = eventosActualizados.filter(e => e.Producto === det.Producto);
            const cantCargada = cargasProducto.length;
            const nuevoEstado = cantCargada >= det.CantidadEsperada ? 'Completo' : 'Pendiente';
            
            let ultimaFecha = null;
            if (cargasProducto.length > 0) {
                const fechas = cargasProducto.map(e => new Date(e.FechaHoraCarga).getTime());
                ultimaFecha = new Date(Math.max(...fechas)).toISOString();
            }

            if (cantCargada !== det.CantidadCargada || det.Estado !== nuevoEstado) {
                await db.updateCamionDetalle(idCamion, det.Producto, cantCargada, nuevoEstado, ultimaFecha);
            }

            if (cantCargada < det.CantidadEsperada) {
                todosCompletos = false;
            }
        }

        // 5. Validar Demoras
        const horaInicio = new Date(camion.HoraInicio);
        const ahora = new Date();
        const transcurridoMinutos = (ahora - horaInicio) / 60000;
        let demorado = camion.Demorado;

        if (!demorado && transcurridoMinutos > camion.TiempoMaximoMinutos) {
            console.log(`⚠️ Alerta: El camión ha superado el tiempo máximo de carga (${camion.TiempoMaximoMinutos} min). Marcando como demorado.`);
            demorado = true;
            await db.updateCamionActivo(idCamion, { Demorado: true });
        }

        // 6. Si el camión está completo, finalizarlo y avanzar secuencias
        if (todosCompletos) {
            console.log(`🎉 ¡Camión ${idCamion} Completado con éxito! Finalizando carga.`);
            await db.updateCamionActivo(idCamion, {
                Estado: 'Finalizado',
                HoraFin: ahora.toISOString()
            });

            // Avance automático independiente por producto
            const autoAdvance = (await db.getParametro('AvanceAutomatico')) === 'true';
            if (autoAdvance) {
                const nextTechos = (camion.SecuenciaInicialTechos + 24) % 1000;
                const nextPaneles = (camion.SecuenciaInicialPaneles + 24) % 1000;
                const nextAsientos = (camion.SecuenciaInicialAsientos + 24) % 1000;
                const nextFiltros = (camion.SecuenciaInicialFiltros + 24) % 1000;

                await db.setParametro('SecuenciaInicial_Techos', nextTechos);
                await db.setParametro('SecuenciaInicial_Paneles', nextPaneles);
                await db.setParametro('SecuenciaInicial_Asientos', nextAsientos);
                await db.setParametro('SecuenciaInicial_Filtros', nextFiltros);
                
                console.log(`🔄 Avance automático activo. Próximas secuencias iniciales: 
                  - Techos: ${formatearSecuenciaTASA(nextTechos)}
                  - Paneles: ${formatearSecuenciaTASA(nextPaneles)}
                  - Asientos: ${formatearSecuenciaTASA(nextAsientos)}
                  - Filtros: ${formatearSecuenciaTASA(nextFiltros)}`);

                // Limpiar despacho simulado al completar un camión
                const modoSim = (await db.getParametro('ModoSimulador')) === 'true';
                if (modoSim) {
                    await db.resetMockDespachos();
                }
            }
        }

    } catch (err) {
        console.error("❌ Error en ciclo de sincronización:", err);
    }
}

// Configura el intervalo constante de verificación
async function inicializarFrecuenciaSincronizacion() {
    if (syncIntervalId) clearInterval(syncIntervalId);
    
    await sincronizarCamionActivo();

    const frecuencia = parseInt(await db.getParametro('FrecuenciaActualizacionSegundos') || '300');
    console.log(`🕒 Sincronizador de base de datos iniciado. Frecuencia: cada ${frecuencia} segundos.`);
    
    // Verificación constante en segundo plano cada 10 segundos
    syncIntervalId = setInterval(async () => {
        await sincronizarCamionActivo();
    }, 10000); 
}

// ==========================================
// 3. MOTOR DEL SIMULADOR ADAPTADO A V2
// ==========================================

async function simularCargaEventos() {
    try {
        const modoSim = (await db.getParametro('ModoSimulador')) === 'true';
        if (!modoSim) return;

        const camion = await db.getCamionActivo();
        if (!camion) return;

        const detalles = await db.getCamionDetalles(camion.IdCamion);
        const eventos = await db.getEventosCarga(camion.IdCamion);

        // Encontrar productos que todavía no están completos (solo simulamos Techos en esta fase)
        const pendientes = detalles.filter(d => d.Producto === 'Techos' && d.CantidadCargada < d.CantidadEsperada);
        if (pendientes.length === 0) return;

        // Seleccionar un producto pendiente al azar
        const prodElegido = pendientes[Math.floor(Math.random() * pendientes.length)];

        // Obtener secuencia inicial según el producto elegido
        let initSeq = 0;
        let expectedQty = prodElegido.CantidadEsperada;
        
        if (prodElegido.Producto === 'Techos') initSeq = camion.SecuenciaInicialTechos;
        else if (prodElegido.Producto === 'Paneles') initSeq = camion.SecuenciaInicialPaneles;
        else if (prodElegido.Producto === 'Asientos') initSeq = camion.SecuenciaInicialAsientos;
        else if (prodElegido.Producto === 'Filtros de aire') initSeq = camion.SecuenciaInicialFiltros;

        // Generar las secuencias esperadas para el producto (0 a 23 posiciones lógicas del camión)
        const secuenciasRango = [];
        // Para Techos, sólo simulamos hasta la cantidad esperada (ej: 12)
        const limitePosiciones = prodElegido.Producto === 'Techos' ? expectedQty : 24;
        for (let i = 0; i < limitePosiciones; i++) {
            secuenciasRango.push((initSeq + i) % 1000);
        }

        // Encontrar qué secuencias de este rango aún no han sido cargadas para este producto
        const cargadasProducto = eventos.filter(e => e.Producto === prodElegido.Producto).map(e => e.SecuenciaTASA);
        const secuenciasDisponibles = secuenciasRango.filter(s => !cargadasProducto.includes(s));

        if (secuenciasDisponibles.length > 0) {
            // Elegir una secuencia al azar y meter un registro simulado
            const secElegida = secuenciasDisponibles[Math.floor(Math.random() * secuenciasDisponibles.length)];
            const modelos = ['MODEL-X', 'MODEL-Y', 'SPORT-PRO', 'STANDARD-TRUCK'];
            const modElegido = modelos[Math.floor(Math.random() * modelos.length)];
            
            await db.insertDespachoRecord(prodElegido.Producto, secElegida, modElegido);
        }

    } catch (err) {
        console.error("❌ Error en simulador de carga:", err);
    }
}

function inicializarMotorSimulador() {
    if (simulatorIntervalId) clearInterval(simulatorIntervalId);
    
    // Correr simulación cada 8 segundos
    console.log("🎮 Motor de simulación v2 cargado (ejecuta en segundo plano si el modo simulador está activo).");
    simulatorIntervalId = setInterval(async () => {
        await simularCargaEventos();
    }, 8000);
}

// ==========================================
// 4. ENDPOINTS API REST (DASHBOARD LOGISTICO)
// ==========================================

// Endpoint: Obtener estado del Dashboard (Camión activo, posiciones lógicas, detalles, tiempos)
app.get('/api/dashboard', async (req, res) => {
    try {
        const camion = await db.getCamionActivo();
        if (!camion) {
            return res.json({ activo: false });
        }

        const detalles = await db.getCamionDetalles(camion.IdCamion);
        const eventos = await db.getEventosCarga(camion.IdCamion);

        const techosEsperados = detalles.find(d => d.Producto === 'Techos')?.CantidadEsperada || 12;

        // Construir las 24 posiciones lógicas del camión
        const posiciones = [];
        const setEventos = {}; // key (Producto_SecuenciaTASA) -> evento
        eventos.forEach(e => {
            setEventos[`${e.Producto}_${e.SecuenciaTASA}`] = e;
        });

        for (let i = 0; i < 24; i++) {
            // Calcular secuencias específicas para esta posición i (0 a 23)
            const seqTecho = (camion.SecuenciaInicialTechos + i) % 1000;
            const seqPanel = (camion.SecuenciaInicialPaneles + i) % 1000;
            const seqAsiento = (camion.SecuenciaInicialAsientos + i) % 1000;
            const seqFiltro = (camion.SecuenciaInicialFiltros + i) % 1000;

            const techosAplica = i < techosEsperados;

            const evTecho = setEventos[`Techos_${seqTecho}`];
            const evPanel = setEventos[`Paneles_${seqPanel}`];
            const evAsiento = setEventos[`Asientos_${seqAsiento}`];
            const evFiltro = setEventos[`Filtros de aire_${seqFiltro}`];

            posiciones.push({
                posicion: i, // 0 a 23
                posicionFormateada: String(i + 1).padStart(2, '0'),
                techos: {
                    secuencia: formatearSecuenciaTASA(seqTecho),
                    aplica: techosAplica,
                    cargado: !!evTecho,
                    modelo: evTecho ? evTecho.Modelo : null,
                    fechaHoraCarga: evTecho ? evTecho.FechaHoraCarga : null
                },
                paneles: {
                    secuencia: formatearSecuenciaTASA(seqPanel),
                    aplica: true,
                    cargado: !!evPanel,
                    modelo: evPanel ? evPanel.Modelo : null,
                    fechaHoraCarga: evPanel ? evPanel.FechaHoraCarga : null
                },
                asientos: {
                    secuencia: formatearSecuenciaTASA(seqAsiento),
                    aplica: true,
                    cargado: !!evAsiento,
                    modelo: evAsiento ? evAsiento.Modelo : null,
                    fechaHoraCarga: evAsiento ? evAsiento.FechaHoraCarga : null
                },
                filtros: {
                    secuencia: formatearSecuenciaTASA(seqFiltro),
                    aplica: true,
                    cargado: !!evFiltro,
                    modelo: evFiltro ? evFiltro.Modelo : null,
                    fechaHoraCarga: evFiltro ? evFiltro.FechaHoraCarga : null
                }
            });
        }

        res.json({
            activo: true,
            camion: {
                idCamion: camion.IdCamion,
                fecha: camion.Fecha,
                turno: camion.Turno,
                horaInicio: camion.HoraInicio,
                tiempoMaximoMinutos: camion.TiempoMaximoMinutos,
                demorado: camion.Demorado === 1 || camion.Demorado === true,
                techos: {
                    inicial: formatearSecuenciaTASA(camion.SecuenciaInicialTechos),
                    final: formatearSecuenciaTASA(camion.SecuenciaFinalTechos)
                },
                paneles: {
                    inicial: formatearSecuenciaTASA(camion.SecuenciaInicialPaneles),
                    final: formatearSecuenciaTASA(camion.SecuenciaFinalPaneles)
                },
                asientos: {
                    inicial: formatearSecuenciaTASA(camion.SecuenciaInicialAsientos),
                    final: formatearSecuenciaTASA(camion.SecuenciaFinalAsientos)
                },
                filtros: {
                    inicial: formatearSecuenciaTASA(camion.SecuenciaInicialFiltros),
                    final: formatearSecuenciaTASA(camion.SecuenciaFinalFiltros)
                }
            },
            posiciones: posiciones,
            detalles: detalles.map(d => ({
                producto: d.Producto,
                esperado: d.CantidadEsperada,
                cargado: d.CantidadCargada,
                estado: d.Estado,
                fechaUltimaCarga: d.FechaUltimaCarga
            })),
            eventos: eventos.map(e => ({
                producto: e.Producto,
                secuenciaTASA: formatearSecuenciaTASA(e.SecuenciaTASA),
                modelo: e.Modelo,
                fechaHoraCarga: e.FechaHoraCarga
            })),
            tiempos: {
                ultimaActualizacion: lastSyncTime,
                proximaActualizacion: nextSyncTime,
                ahoraServidor: new Date()
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper para escribir y actualizar el archivo .env
function updateEnvFile(updates) {
    const fs = require('fs');
    const fsPath = require('path');
    const envPath = fsPath.join(__dirname, '.env');
    let content = '';
    if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
    }
    
    const lines = content.split(/\r?\n/);
    const newLines = [];
    const updatedKeys = new Set();
    
    for (const line of lines) {
        const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)\s*$/);
        if (match) {
            const key = match[1];
            if (updates[key] !== undefined) {
                newLines.push(`${key}=${updates[key]}`);
                updatedKeys.add(key);
                continue;
            }
        }
        newLines.push(line);
    }
    
    // Agregar claves que no estaban en el .env anterior
    for (const [key, val] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
            newLines.push(`${key}=${val}`);
        }
    }
    
    fs.writeFileSync(envPath, newLines.join('\n'), 'utf8');
}

// Endpoint: Obtener configuración actual de base de datos
app.get('/api/db/config', (req, res) => {
    res.json({
        DB_SERVER: process.env.DB_SERVER || 'localhost',
        DB_DATABASE: process.env.DB_DATABASE || 'JITMS',
        DB_USER: process.env.DB_USER || '',
        DB_PASSWORD: process.env.DB_PASSWORD || '',
        DB_PORT: process.env.DB_PORT || '1433',
        DB_ENCRYPT: process.env.DB_ENCRYPT === 'true',
        DB_TRUST_SERVER_CERTIFICATE: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
    });
});

// Endpoint: Probar conexión temporalmente
app.post('/api/db/test', async (req, res) => {
    const { server, database, user, password, port, encrypt, trustServerCertificate } = req.body;
    
    const testConfig = {
        user: user || undefined,
        password: password || undefined,
        server: server || 'localhost',
        database: database || undefined,
        port: parseInt(port || '1433'),
        options: {
            encrypt: encrypt === true,
            trustServerCertificate: trustServerCertificate === true
        },
        connectionTimeout: 5000 // 5 segundos de espera máxima para pruebas
    };
    
    const sql = require('mssql');
    let tempPool = null;
    try {
        console.log(`🔌 Probando conexión temporal a SQL Server: ${testConfig.server}:${testConfig.port}...`);
        tempPool = await sql.connect(testConfig);
        // Hacer una consulta de prueba ultra rápida
        await tempPool.request().query("SELECT 1 as test");
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Test de conexión fallido:", err.message);
        res.json({ success: false, error: err.message });
    } finally {
        if (tempPool) {
            try {
                await tempPool.close();
            } catch (e) {}
        }
    }
});

// Endpoint: Guardar configuración de base de datos y reconectar en caliente
app.post('/api/db/config', async (req, res) => {
    const { server, database, user, password, port, encrypt, trustServerCertificate } = req.body;
    
    try {
        const updates = {
            DB_SERVER: server || 'localhost',
            DB_DATABASE: database || 'JITMS',
            DB_USER: user || '',
            DB_PASSWORD: password || '',
            DB_PORT: port || '1433',
            DB_ENCRYPT: String(encrypt === true),
            DB_TRUST_SERVER_CERTIFICATE: String(trustServerCertificate === true),
            SIMULATOR_MODE: 'false' // Forzar desactivación de simulación global si guardamos base de datos real
        };
        
        // 1. Guardar a archivo .env
        updateEnvFile(updates);
        
        // 2. Modificar en memoria del proceso
        for (const [key, val] of Object.entries(updates)) {
            process.env[key] = val;
        }
        
        // 3. Reconectar la base de datos en caliente
        await db.reconfigureConnection();
        
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Error al guardar reconfiguración de DB:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Obtener parámetros de configuración
app.get('/api/parametros', async (req, res) => {
    try {
        const params = await db.getParametros();
        const paramObj = {};
        params.forEach(p => {
            paramObj[p.NombreParametro] = p.ValorParametro;
        });
        res.json(paramObj);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: Guardar parámetros de configuración
app.post('/api/parametros', async (req, res) => {
    try {
        const body = req.body;
        
        let camionInicialCambiado = false;
        
        // Verificamos si alguna de las 4 secuencias iniciales ha cambiado
        const prevTechos = await db.getParametro('SecuenciaInicial_Techos');
        const prevPaneles = await db.getParametro('SecuenciaInicial_Paneles');
        const prevAsientos = await db.getParametro('SecuenciaInicial_Asientos');
        const prevFiltros = await db.getParametro('SecuenciaInicial_Filtros');

        for (const [key, val] of Object.entries(body)) {
            await db.setParametro(key, val);
            
            if (key === 'SecuenciaInicial_Techos' && String(val) !== String(prevTechos)) camionInicialCambiado = true;
            if (key === 'SecuenciaInicial_Paneles' && String(val) !== String(prevPaneles)) camionInicialCambiado = true;
            if (key === 'SecuenciaInicial_Asientos' && String(val) !== String(prevAsientos)) camionInicialCambiado = true;
            if (key === 'SecuenciaInicial_Filtros' && String(val) !== String(prevFiltros)) camionInicialCambiado = true;
        }

        // Si cambió alguna secuencia inicial, finalizamos el camión actual
        // para gatillar la creación de uno nuevo en base a las nuevas secuencias.
        if (camionInicialCambiado) {
            const camionActivo = await db.getCamionActivo();
            if (camionActivo) {
                console.log(`⚙️ Secuencia(s) inicial(es) modificada(s). Finalizando camión activo actual (ID: ${camionActivo.IdCamion}) para iniciar el nuevo rango.`);
                await db.updateCamionActivo(camionActivo.IdCamion, { Estado: 'Finalizado' });
            }
            if (body.ModoSimulador === 'true') {
                await db.resetMockDespachos();
            }
        }

        await sincronizarCamionActivo();
        
        res.json({ success: true, message: "Parámetros actualizados correctamente." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: Obtener histórico
app.get('/api/historial', async (req, res) => {
    try {
        const { fecha, turno } = req.query;
        const historial = await db.getHistorial(fecha, turno);
        
        const historialFormateado = historial.map(h => ({
            idCamion: h.IdCamion,
            fecha: h.Fecha instanceof Date ? h.Fecha.toISOString().split('T')[0] : h.Fecha,
            turno: h.Turno,
            horaInicio: h.HoraInicio,
            horaFin: h.HoraFin,
            tiempoMaximoMinutos: h.TiempoMaximoMinutos,
            demorado: h.Demorado === 1 || h.Demorado === true,
            techos: { 
                esperado: h.Techos_Esp, 
                cargado: h.Techos_Real, 
                inicial: formatearSecuenciaTASA(h.SecuenciaInicialTechos), 
                final: formatearSecuenciaTASA(h.SecuenciaFinalTechos) 
            },
            paneles: { 
                esperado: h.Paneles_Esp, 
                cargado: h.Paneles_Real, 
                inicial: formatearSecuenciaTASA(h.SecuenciaInicialPaneles), 
                final: formatearSecuenciaTASA(h.SecuenciaFinalPaneles) 
            },
            asientos: { 
                esperado: h.Asientos_Esp, 
                cargado: h.Asientos_Real, 
                inicial: formatearSecuenciaTASA(h.SecuenciaInicialAsientos), 
                final: formatearSecuenciaTASA(h.SecuenciaFinalAsientos) 
            },
            filtros: { 
                esperado: h.Filtros_Esp, 
                cargado: h.Filtros_Real, 
                inicial: formatearSecuenciaTASA(h.SecuenciaInicialFiltros), 
                final: formatearSecuenciaTASA(h.SecuenciaFinalFiltros) 
            }
        }));
        
        res.json(historialFormateado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: Refrescar manual
app.post('/api/sincronizar', async (req, res) => {
    try {
        await sincronizarCamionActivo();
        res.json({
            success: true,
            ultimaActualizacion: lastSyncTime,
            proximaActualizacion: nextSyncTime
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: Resetear simulación
app.post('/api/simulador/reset', async (req, res) => {
    try {
        await db.resetMockDespachos();
        await sincronizarCamionActivo();
        res.json({ success: true, message: "Tablas despacho temporales reseteadas." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 5. ARRANQUE DEL SERVIDOR
// ==========================================

async function startServer() {
    await inicializarFrecuenciaSincronizacion();
    inicializarMotorSimulador();

    app.listen(PORT, () => {
        console.log(`🚀 Servidor TruckFlow v2 iniciado en http://localhost:${PORT}`);
    });
}

startServer();
