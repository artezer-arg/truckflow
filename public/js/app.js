// VARIABLES GLOBALES DE TRUCKFLOW MOCKUP EXACTO
let currentView = 'dashboard';
let dashboardPollInterval = null;
let clockInterval = null;
let activeTruckStartTime = null;
let activeTruckMaxMinutes = 28;
let nextSyncTimestamp = null;
let activeTruckFinished = false;
let showGridsDetailed = false;

// Al cargar el documento
document.addEventListener('DOMContentLoaded', () => {
    inicializarRelojPlanta();
    switchView('dashboard');
    
    // Polling del Dashboard cada 5 segundos
    dashboardPollInterval = setInterval(fetchDashboardData, 5000);
    fetchDashboardData();
    
    // Cargar parámetros en settings
    cargarValoresFormParametros();

    // Establecer fecha por defecto en el historial (hoy)
    document.getElementById('filter-date').value = new Date().toISOString().split('T')[0];
});

// ==========================================
// 1. RELOJ Y TURNO DE PLANTA EN TIEMPO REAL
// ==========================================
function inicializarRelojPlanta() {
    const clockEl = document.getElementById('header-clock');
    const dateEl = document.getElementById('header-date');
    const shiftEl = document.getElementById('header-shift');

    function actualizarReloj() {
        const ahora = new Date();
        
        // Formatear Hora
        const horas = String(ahora.getHours()).padStart(2, '0');
        const minutos = String(ahora.getMinutes()).padStart(2, '0');
        const segundos = String(ahora.getSeconds()).padStart(2, '0');
        clockEl.innerText = `${horas}:${minutos}:${segundos}`;

        // Formatear Fecha
        const dia = String(ahora.getDate()).padStart(2, '0');
        const mes = String(ahora.getMonth() + 1).padStart(2, '0');
        const anio = ahora.getFullYear();
        dateEl.innerText = `${dia}/${mes}/${anio}`;

        // Calcular Turno
        const turno = calcularTurnoPlanta(ahora.getHours(), ahora.getMinutes());
        shiftEl.innerText = turno;

        // Actualizar el cronómetro del camión activo y estimador de fin
        actualizarCronometroYEstimaciones();

        // Actualizar cuenta regresiva de sync
        actualizarCuentaRegresivaSync();
    }

    actualizarReloj();
    clockInterval = setInterval(actualizarReloj, 1000);
}

function calcularTurnoPlanta(hora, minutos) {
    const tiempoMinutos = hora * 60 + minutos;
    if (tiempoMinutos >= 360 && tiempoMinutos < 840) return "Turno 1 (Mañana)";
    else if (tiempoMinutos >= 840 && tiempoMinutos < 1320) return "Turno 2 (Tarde)";
    else return "Turno 3 (Noche)";
}

// ==========================================
// 2. SPA ROUTING (CAMBIO DE PANTALLAS)
// ==========================================
function switchView(viewName) {
    currentView = viewName;
    
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
    });
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.getElementById(`view-${viewName}`).classList.add('active');
    
    if (viewName === 'dashboard') {
        document.getElementById('nav-dashboard').classList.add('active');
        fetchDashboardData();
    } else if (viewName === 'history') {
        document.getElementById('nav-history').classList.add('active');
        loadHistory();
    } else if (viewName === 'settings') {
        document.getElementById('nav-settings').classList.add('active');
        cargarValoresFormParametros();
    }
}

// Expandir/colapsar grillas técnicas secundarias
function toggleDetailedGrids() {
    showGridsDetailed = !showGridsDetailed;
    const container = document.getElementById('detailed-grids-container');
    const toggleIcon = document.getElementById('grids-toggle-icon');
    
    if (showGridsDetailed) {
        container.classList.remove('hidden');
        toggleIcon.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Ocultar Grilla';
        fetchDashboardData();
    } else {
        container.classList.add('hidden');
        toggleIcon.innerHTML = '<i class="fa-solid fa-chevron-down"></i> Mostrar Grilla';
    }
}

// ==========================================
// 3. CONSULTA Y RENDERIZADO DEL DASHBOARD
// ==========================================

let totalLoadedForEstimation = 0;
let totalExpectedForEstimation = 0;

async function fetchDashboardData() {
    if (currentView !== 'dashboard') return;

    try {
        const response = await fetch('/api/dashboard');
        const data = await response.json();

        if (!data.activo) {
            document.getElementById('active-truck-name').innerText = "No hay camión activo";
            return;
        }

        // 1. Tiempos y Actualización
        nextSyncTimestamp = data.tiempos.proximaActualizacion;
        
        const lastSync = new Date(data.tiempos.ultimaActualizacion);
        document.getElementById('sync-last').innerText = `${String(lastSync.getHours()).padStart(2, '0')}:${String(lastSync.getMinutes()).padStart(2, '0')}:${String(lastSync.getSeconds()).padStart(2, '0')}`;

        // 2. Rellenar Metadatos del Camión Activo
        const camion = data.camion;
        activeTruckStartTime = camion.horaInicio;
        activeTruckMaxMinutes = camion.tiempoMaximoMinutos;
        activeTruckFinished = false;

        document.getElementById('active-truck-name').innerText = `Camión TASA - Cabina #${camion.idCamion}`;

        // Bordes de advertencia en el acoplado si se demora
        const cargoBox = document.getElementById('truck-cargo-container');
        const statusBadge = document.getElementById('truck-status-badge');
        
        if (camion.demorado) {
            statusBadge.className = 'status-badge demorado';
            statusBadge.innerText = 'DEMORADO';
            cargoBox.classList.add('demorado');
            document.querySelector('.truck-control-card').style.borderColor = '#ef4444';
        } else {
            statusBadge.className = 'status-badge';
            statusBadge.innerText = 'CARGANDO';
            cargoBox.classList.remove('demorado');
            document.querySelector('.truck-control-card').style.borderColor = '';
        }

        // 3. Calcular Totales y Porcentajes de Carga General
        let totalCargado = 0;
        let totalEsperado = 0;

        data.detalles.forEach(det => {
            totalCargado += det.cargado;
            totalEsperado += det.esperado;
        });

        totalLoadedForEstimation = totalCargado;
        totalExpectedForEstimation = totalEsperado;

        const overallPct = totalExpectedForEstimation > 0 ? Math.round((totalLoadedForEstimation / totalExpectedForEstimation) * 100) : 0;

        // Girar ruedas en base a si se está cargando y no finalizó
        const wheels = document.querySelectorAll('.wheel');
        wheels.forEach(w => {
            if (overallPct < 100) {
                w.classList.add('spinning');
            } else {
                w.classList.remove('spinning');
            }
        });

        // 4. Rellenar las 4 columnas de carga en el acoplado integrado
        data.detalles.forEach(det => {
            let key = '';
            let labelRange = '';
            if (det.producto === 'Techos') {
                key = 'techos';
                labelRange = `${camion.techos.inicial} a ${camion.techos.final}`;
            } else if (det.producto === 'Paneles') {
                key = 'paneles';
                labelRange = `${camion.paneles.inicial} a ${camion.paneles.final}`;
            } else if (det.producto === 'Asientos') {
                key = 'asientos';
                labelRange = `${camion.asientos.inicial} a ${camion.asientos.final}`;
            } else if (det.producto === 'Filtros de aire') {
                key = 'filtros';
                labelRange = `${camion.filtros.inicial} a ${camion.filtros.final}`;
            }

            if (!key) return;

            const pct = det.esperado > 0 ? Math.round((det.cargado / det.esperado) * 100) : 0;

            // Rellenar etiquetas de la columna
            document.getElementById(`col-frac-${key}`).innerText = `${det.cargado} / ${det.esperado}`;
            document.getElementById(`col-pct-${key}`).innerText = `${pct}%`;
            
            // Rellenar pastilla de secuencia flotante debajo de la columna
            document.getElementById(`col-seq-${key}`).innerText = labelRange;
            
            // Altura vertical del relleno
            const fillBar = document.getElementById(`col-fill-${key}`);
            fillBar.style.height = `${Math.min(pct, 100)}%`;

            // Efecto wave si cargó algo recientemente
            if (det.fechaUltimaCarga && esCargaReciente(det.fechaUltimaCarga)) {
                fillBar.classList.add('newly-loaded');
            } else {
                fillBar.classList.remove('newly-loaded');
            }

            // Aplicar clase complete si está al 100% para contrastar textos a blanco
            const colItem = document.getElementById(`col-item-${key}`);
            if (det.cargado >= det.esperado) {
                colItem.classList.add('complete');
            } else {
                colItem.classList.remove('complete');
            }

            // Actualizar fila de resumen lateral (Resumen Table)
            document.getElementById(`sum-frac-${key}`).innerText = `${det.cargado} / ${det.esperado}`;
            document.getElementById(`sum-pct-${key}`).innerText = `${pct}%`;
        });

        // Contadores numéricos de la tarjeta superior (si existen en el HTML)
        const overallPctEl = document.getElementById('overall-pct-text');
        if (overallPctEl) overallPctEl.innerText = `${overallPct}%`;
        
        const overallFractionEl = document.getElementById('overall-fraction-text');
        if (overallFractionEl) overallFractionEl.innerText = `${totalCargado} / ${totalEsperado}`;
        
        const overallProgressBarEl = document.getElementById('overall-progress-bar');
        if (overallProgressBarEl) overallProgressBarEl.style.width = `${Math.min(overallPct, 100)}%`;

        // 5. Actualizar el Donut de Avance General de la Barra Lateral
        document.getElementById('donut-pct').innerText = `${overallPct}%`;
        document.getElementById('donut-fraction').innerText = `${totalCargado} / ${totalEsperado}`;
        document.getElementById('donut-progress-segment').setAttribute('stroke-dasharray', `${overallPct}, 100`);

        // 6. Renderizar Grilla Técnica si la pestaña está abierta
        if (showGridsDetailed) {
            renderizarGrillaTecnica(data.posiciones, data.detalles);
        }

    } catch (err) {
        console.error("Error al consultar datos del dashboard:", err);
    }
}

// Dibuja los cuadrados lógicos por secuencia en la pestaña secundaria
function renderizarGrillaTecnica(posiciones, detalles) {
    const prods = [
        { key: 'asientos', container: 'squares-asientos', expected: 24 },
        { key: 'paneles', container: 'squares-paneles', expected: 24 },
        { key: 'techos', container: 'squares-techos', expected: detalles.find(d => d.producto === 'Techos')?.esperado || 12 },
        { key: 'filtros', container: 'squares-filtros', expected: 24 }
    ];

    prods.forEach(p => {
        const container = document.getElementById(p.container);
        container.innerHTML = ''; // Vaciar
        
        for (let i = 0; i < p.expected; i++) {
            const sq = document.createElement('div');
            sq.className = 'sq-block';
            
            const cellData = posiciones[i];
            if (cellData && cellData[p.key]) {
                const item = cellData[p.key];
                sq.innerText = item.secuencia;
                
                if (item.cargado) {
                    sq.classList.add('loaded');
                    sq.title = `Secuencia lógica ${item.secuencia}\nModelo: ${item.modelo}\nHora: ${formatearHora(item.fechaHoraCarga)}`;
                } else {
                    sq.title = `Secuencia lógica ${item.secuencia} (Pendiente)`;
                }
            } else {
                sq.innerText = '--';
                sq.title = 'No Aplica';
            }
            container.appendChild(sq);
        }
    });
}

// ==========================================
// 4. CRONOMETRO, TIMELINE Y ESTIMADOR LOGISTICO
// ==========================================
function actualizarCronometroYEstimaciones() {
    if (!activeTruckStartTime || activeTruckFinished) return;

    const ahora = new Date();
    const inicio = new Date(activeTruckStartTime);
    const difMs = ahora - inicio;
    
    if (difMs < 0) return;

    // 1. Actualizar tiempo transcurrido
    const difSegs = Math.floor(difMs / 1000);
    const mins = Math.floor(difSegs / 60);
    const segs = difSegs % 60;
    
    const formattedDuration = `${String(mins).padStart(2, '0')}:${String(segs).padStart(2, '0')}`;
    document.getElementById('truck-duration').innerText = formattedDuration;

    // Hora de inicio en el Timeline
    document.getElementById('timeline-start-time').innerText = `${String(inicio.getHours()).padStart(2, '0')}:${String(inicio.getMinutes()).padStart(2, '0')}:${String(inicio.getSeconds()).padStart(2, '0')}`;

    // Actualizar punto central de la línea de tiempo (PLAY -> CLOCK -> FLAG)
    document.getElementById('timeline-elapsed-time').innerText = formattedDuration;

    // 2. Calcular límites y alarmas
    const maxMinutes = activeTruckMaxMinutes;
    document.getElementById('truck-limit').innerText = `${maxMinutes} min`;

    const limitMs = maxMinutes * 60000;

    // Progreso de la línea
    const timelinePct = Math.min(100, (difMs / limitMs) * 100);
    document.getElementById('timeline-progress-bar').style.width = `${timelinePct}%`;

    // 3. Tiempo restante antes de la demora
    const remainingContainer = document.getElementById('metric-remaining-container');
    const remainingEl = document.getElementById('truck-remaining');
    const difRestanteMs = limitMs - difMs;

    if (difRestanteMs <= 0) {
        remainingEl.innerText = "Excedido";
        remainingEl.className = "top-metric-value text-blue";
        remainingContainer.querySelector('.top-metric-label').innerText = "EXCESO DE TIEMPO";
    } else {
        remainingContainer.querySelector('.top-metric-label').innerText = "ANTES DE DEMORA";
        const remSegs = Math.floor(difRestanteMs / 1000);
        const remMins = Math.floor(remSegs / 60);
        const remS = remSegs % 60;
        remainingEl.innerText = `${String(remMins).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
        remainingEl.className = "top-metric-value text-green";
    }

    // 4. Estimador de finalización
    const estEndEl = document.getElementById('timeline-estimate-end');
    const endWrapper = document.getElementById('timeline-end-icon-wrapper');
    
    if (totalLoadedForEstimation === 0) {
        estEndEl.innerText = "Esp. primera carga";
        endWrapper.className = "timeline-icon-wrapper gray";
    } else if (totalLoadedForEstimation === totalExpectedForEstimation) {
        estEndEl.innerText = "Completado";
        endWrapper.className = "timeline-icon-wrapper green";
    } else {
        endWrapper.className = "timeline-icon-wrapper gray";
        const rate = totalLoadedForEstimation / difMs;
        const remainingUnits = totalExpectedForEstimation - totalLoadedForEstimation;
        const estRemainingMs = remainingUnits / rate;

        const dateEst = new Date(ahora.getTime() + estRemainingMs);
        const estH = String(dateEst.getHours()).padStart(2, '0');
        const estM = String(dateEst.getMinutes()).padStart(2, '0');
        const estS = String(dateEst.getSeconds()).padStart(2, '0');

        estEndEl.innerText = `${estH}:${estM}:${estS}`;
    }
}

function actualizarCuentaRegresivaSync() {
    if (!nextSyncTimestamp) return;

    const ahora = new Date();
    const siguiente = new Date(nextSyncTimestamp);
    const difMs = siguiente - ahora;
    const labelNext = document.getElementById('sync-next');

    if (difMs <= 0) {
        labelNext.innerText = "0m 00s";
        return;
    }

    const difSegs = Math.floor(difMs / 1000);
    const mins = Math.floor(difSegs / 60);
    const segs = difSegs % 60;
    
    labelNext.innerText = `${mins}m ${String(segs).padStart(2, '0')}s`;
}

// Sincronización manual
async function forceSync() {
    const btn = document.getElementById('btn-force-sync');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refrescando...';

    try {
        const response = await fetch('/api/sincronizar', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            nextSyncTimestamp = data.proximaActualizacion;
            showToast("Datos actualizados de SQL Server.");
            await fetchDashboardData();
        }
    } catch (err) {
        console.error(err);
        showToast("Error de red.", "danger");
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Refrescar Datos';
    }
}

// ==========================================
// 5. HISTORIAL DE CARGAS
// ==========================================
async function loadHistory() {
    if (currentView !== 'history') return;

    const dateVal = document.getElementById('filter-date').value;
    const shiftVal = document.getElementById('filter-shift').value;
    
    let url = '/api/historial';
    const params = [];
    if (dateVal) params.push(`fecha=${dateVal}`);
    if (shiftVal) params.push(`turno=${encodeURIComponent(shiftVal)}`);
    if (params.length > 0) url += `?${params.join('&')}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        
        const rowsContainer = document.getElementById('history-rows');
        const emptyState = document.getElementById('history-empty');
        const table = document.getElementById('history-table');

        rowsContainer.innerHTML = '';

        if (data.length === 0) {
            emptyState.classList.remove('hidden');
            table.classList.add('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        table.classList.remove('hidden');

        data.forEach(h => {
            const tr = document.createElement('tr');
            const duracion = calcularDuracion(h.horaInicio, h.horaFin);
            
            const demBadge = h.demorado 
                ? '<span class="badge danger"><i class="fa-solid fa-triangle-exclamation"></i> Sí</span>' 
                : '<span class="badge success"><i class="fa-solid fa-check"></i> No</span>';

            tr.innerHTML = `
                <td><strong>CAM-${h.idCamion}</strong></td>
                <td>${formatearFechaLenta(h.fecha)}</td>
                <td>${h.turno}</td>
                
                <td><span class="badge-normal">${h.techos.inicial} a ${h.techos.final} (${h.techos.cargado}/${h.techos.esperado})</span></td>
                <td><span class="badge-normal">${h.paneles.inicial} a ${h.paneles.final} (${h.paneles.cargado}/${h.paneles.esperado})</span></td>
                <td><span class="badge-normal">${h.asientos.inicial} a ${h.asientos.final} (${h.asientos.cargado}/${h.asientos.esperado})</span></td>
                <td><span class="badge-normal">${h.filtros.inicial} a ${h.filtros.final} (${h.filtros.cargado}/${h.filtros.esperado})</span></td>
                
                <td>${formatearHoraCompleta(h.horaInicio)}</td>
                <td>${h.horaFin ? formatearHoraCompleta(h.horaFin) : '--:--:--'}</td>
                <td>${duracion}</td>
                <td>${demBadge}</td>
            `;
            rowsContainer.appendChild(tr);
        });

    } catch (err) {
        console.error("Error al cargar historial:", err);
        showToast("Error al cargar historial.", "danger");
    }
}

// Auxiliares
function resetHistoryFilters() {
    document.getElementById('filter-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('filter-shift').value = '';
    loadHistory();
}

function calcularDuracion(inicioStr, finStr) {
    if (!finStr) return '--:--';
    const init = new Date(inicioStr);
    const end = new Date(finStr);
    const difMs = end - init;
    if (difMs < 0) return '00:00';
    
    const totalSegs = Math.floor(difMs / 1000);
    const horas = Math.floor(totalSegs / 3600);
    const mins = Math.floor((totalSegs % 3600) / 60);
    const segs = totalSegs % 60;
    
    if (horas > 0) return `${horas}h ${mins}m ${segs}s`;
    return `${mins}m ${segs}s`;
}

function formatearFechaLenta(fechaStr) {
    const parts = fechaStr.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return fechaStr;
}

function formatearHoraCompleta(fechaStr) {
    const d = new Date(fechaStr);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function esCargaReciente(fechaStr) {
    const ahora = new Date();
    const fechaCarga = new Date(fechaStr);
    const difMs = ahora - fechaCarga;
    return difMs >= 0 && difMs < 45000;
}

function formatearHora(fechaStr) {
    const d = new Date(fechaStr);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ==========================================
// 6. PARÁMETROS: CONFIGURACIÓN
// ==========================================
async function cargarValoresFormParametros() {
    try {
        const response = await fetch('/api/parametros');
        const data = await response.json();

        // Secuencias iniciales
        document.getElementById('param-seq-techos').value = parseInt(data.SecuenciaInicial_Techos || '100');
        document.getElementById('param-seq-paneles').value = parseInt(data.SecuenciaInicial_Paneles || '120');
        document.getElementById('param-seq-asientos').value = parseInt(data.SecuenciaInicial_Asientos || '100');
        document.getElementById('param-seq-filtros').value = parseInt(data.SecuenciaInicial_Filtros || '098');
        
        // Cantidades esperadas
        document.getElementById('param-techos').value = parseInt(data.Techos_Esperados || '12');
        document.getElementById('param-paneles').value = parseInt(data.Paneles_Esperados || '24');
        document.getElementById('param-asientos').value = parseInt(data.Asientos_Esperados || '24');
        document.getElementById('param-filtros').value = parseInt(data.Filtros_Esperados || '24');

        // Límites y frecuencia
        const limitMin = parseInt(data.TiempoMaximoCargaMinutos || '28');
        document.getElementById('param-max-time').value = limitMin;
        document.getElementById('max-time-val').innerText = limitMin;
        
        document.getElementById('param-refresh').value = data.FrecuenciaActualizacionSegundos || '300';
        document.getElementById('param-auto-advance').checked = data.AvanceAutomatico === 'true';

        // Modo Simulador
        const simActivo = data.ModoSimulador === 'true';
        document.getElementById('param-simulator-mode').checked = simActivo;
        
        const statusText = document.getElementById('sim-status-text');
        if (simActivo) {
            statusText.innerText = 'ACTIVADO';
            statusText.parentElement.className = 'debug-status-card';
        } else {
            statusText.innerText = 'DESACTIVADO';
            statusText.parentElement.className = 'debug-status-card off';
        }

        // Cargar también la configuración de conexión de DB
        await cargarValoresConexionDB();

    } catch (err) {
        console.error("Error al cargar parámetros:", err);
    }
}

async function saveSettings(event) {
    event.preventDefault();
    
    const body = {
        SecuenciaInicial_Techos: document.getElementById('param-seq-techos').value,
        SecuenciaInicial_Paneles: document.getElementById('param-seq-paneles').value,
        SecuenciaInicial_Asientos: document.getElementById('param-seq-asientos').value,
        SecuenciaInicial_Filtros: document.getElementById('param-seq-filtros').value,
        
        Techos_Esperados: document.getElementById('param-techos').value,
        Paneles_Esperados: document.getElementById('param-paneles').value,
        Asientos_Esperados: document.getElementById('param-asientos').value,
        Filtros_Esperados: document.getElementById('param-filtros').value,
        
        TiempoMaximoCargaMinutos: document.getElementById('param-max-time').value,
        FrecuenciaActualizacionSegundos: document.getElementById('param-refresh').value,
        AvanceAutomatico: String(document.getElementById('param-auto-advance').checked)
    };

    try {
        const response = await fetch('/api/parametros', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();

        if (data.success) {
            showToast("Parámetros guardados y aplicados correctamente.");
            setTimeout(() => {
                switchView('dashboard');
            }, 1000);
        } else {
            showToast("Error al guardar parámetros.", "danger");
        }
    } catch (err) {
        console.error(err);
        showToast("Error de conexión al servidor.", "danger");
    }
}

async function toggleSimulatorMode(enabled) {
    const body = { ModoSimulador: String(enabled) };
    try {
        const response = await fetch('/api/parametros', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        
        if (data.success) {
            showToast(enabled ? "Simulador activado." : "Simulador desactivado.");
            cargarValoresFormParametros();
        }
    } catch (err) {
        console.error(err);
        showToast("Error al cambiar modo de simulación.", "danger");
    }
}

async function resetSimulatorData() {
    if (!confirm("¿Está seguro de vaciar los despachos simulados? Esto reiniciará el avance del camión activo al 0%.")) return;
    
    try {
        const response = await fetch('/api/simulador/reset', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            showToast("Progreso de simulación reiniciado.");
            fetchDashboardData();
        } else {
            showToast("Error al resetear simulación.", "danger");
        }
    } catch (err) {
        console.error(err);
        showToast("Error de conexión.", "danger");
    }
}

// ==========================================
// 7. TOAST NOTIFICACIONES
// ==========================================
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-message');
    
    toastMsg.innerText = message;
    
    if (type === 'success') {
        toast.style.background = '#0f172a';
        toast.querySelector('.toast-icon').className = 'fa-solid fa-circle-check toast-icon';
        toast.querySelector('.toast-icon').style.color = 'var(--state-completo)';
    } else {
        toast.style.background = '#7f1d1d';
        toast.querySelector('.toast-icon').className = 'fa-solid fa-triangle-exclamation toast-icon';
        toast.querySelector('.toast-icon').style.color = '#fca5a5';
    }
    
    toast.classList.remove('hidden');
    
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

// ==========================================
// 8. MANEJO DE CONEXIÓN Y TEST DE BASE DE DATOS
// ==========================================
async function cargarValoresConexionDB() {
    try {
        const response = await fetch('/api/db/config');
        const data = await response.json();
        
        document.getElementById('db-server').value = data.DB_SERVER || '';
        document.getElementById('db-database').value = data.DB_DATABASE || '';
        document.getElementById('db-user').value = data.DB_USER || '';
        document.getElementById('db-password').value = data.DB_PASSWORD || '';
        document.getElementById('db-port').value = data.DB_PORT || '1433';
        document.getElementById('db-encrypt').checked = data.DB_ENCRYPT === true;
        document.getElementById('db-trust-cert').checked = data.DB_TRUST_SERVER_CERTIFICATE === true;
    } catch (err) {
        console.error("Error al cargar config de DB:", err);
    }
}

async function testDbConnection() {
    const statusBox = document.getElementById('db-test-status');
    const statusIcon = document.getElementById('db-status-icon');
    const statusMsg = document.getElementById('db-status-msg');
    
    statusBox.className = "db-test-status-box";
    statusBox.style.backgroundColor = "#f1f5f9";
    statusBox.style.borderColor = "#cbd5e1";
    statusBox.style.color = "#475569";
    statusIcon.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ';
    statusMsg.innerText = "Probando conexión a SQL Server...";
    statusBox.classList.remove('hidden');
    
    const body = {
        server: document.getElementById('db-server').value,
        database: document.getElementById('db-database').value,
        user: document.getElementById('db-user').value,
        password: document.getElementById('db-password').value,
        port: document.getElementById('db-port').value,
        encrypt: document.getElementById('db-encrypt').checked,
        trustServerCertificate: document.getElementById('db-trust-cert').checked
    };
    
    try {
        const response = await fetch('/api/db/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        
        if (data.success) {
            statusBox.className = "db-test-status-box success";
            statusBox.style.backgroundColor = ""; // clean styles from CSS
            statusBox.style.borderColor = "";
            statusBox.style.color = "";
            statusIcon.innerHTML = '<i class="fa-solid fa-circle-check"></i> ';
            statusMsg.innerText = "Conexión Exitosa. SQL Server responde correctamente.";
            showToast("Conexión de prueba exitosa.");
        } else {
            statusBox.className = "db-test-status-box failure";
            statusBox.style.backgroundColor = "";
            statusBox.style.borderColor = "";
            statusBox.style.color = "";
            statusIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ';
            statusMsg.innerText = "Error: " + data.error;
            showToast("Conexión de prueba fallida.", "danger");
        }
    } catch (err) {
        statusBox.className = "db-test-status-box failure";
        statusBox.style.backgroundColor = "";
        statusBox.style.borderColor = "";
        statusBox.style.color = "";
        statusIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ';
        statusMsg.innerText = "Error de red: no se pudo consultar al servidor local.";
        showToast("Error al probar conexión.", "danger");
    }
}

async function saveDbConnection() {
    if (!confirm("¿Está seguro de guardar estos parámetros? El servidor intentará conectarse a la nueva base de datos y desactivará el simulador local para usar los datos reales de JITMS.")) return;
    
    const body = {
        server: document.getElementById('db-server').value,
        database: document.getElementById('db-database').value,
        user: document.getElementById('db-user').value,
        password: document.getElementById('db-password').value,
        port: document.getElementById('db-port').value,
        encrypt: document.getElementById('db-encrypt').checked,
        trustServerCertificate: document.getElementById('db-trust-cert').checked
    };
    
    try {
        const response = await fetch('/api/db/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        
        if (data.success) {
            showToast("Configuración guardada y base de datos reconectada.");
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } else {
            showToast("Error al guardar credenciales: " + data.error, "danger");
        }
    } catch (err) {
        console.error(err);
        showToast("Error de conexión al servidor.", "danger");
    }
}
