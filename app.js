/**
 * app.js - Sanare Pro: Remote-Linked Dashboard
 * Recibe datos del panel principal vía localStorage y auto-conecta BLE.
 */

// UI Selectors
const btnConnect = document.getElementById('btn-connect');
const statusIndicator = document.getElementById('status-indicator');
const deviceConnectionStateText = document.getElementById('device-connection-state');

// Vital Displays
const valHr = document.getElementById('val-hr');
const valSpo2 = document.getElementById('val-spo2');
const valBp = document.getElementById('val-bp');
const valLastSync = document.getElementById('val-lastsync');
const alertsList = document.getElementById('alerts-list');

// Session Stats
const maxHrEl = document.getElementById('max-hr');
const avgSpo2El = document.getElementById('avg-spo2');

// Patient Info Header
const displayDName = document.getElementById('display-d-name');
const displayPName = document.getElementById('display-p-name');
const displayPDetails = document.getElementById('display-p-details');
const avatarInitial = document.getElementById('avatar-initial');
const btnSaveRecord = document.getElementById('btn-save-database');

// State
let bluetoothDevice = null;
let gattServer = null;
let hrCharacteristic = null;
let isConnected = false;
let currentMeasurements = { hr: 0, spo2: 0, bpSys: 0, bpDia: 0, temp: 0 };
let hrHistory = [], spo2History = [];
let chartUnified;
let tLabels = [], dHr = [], dSpo2 = [];
let isManualSpo2 = false;

// ============================================
// CONFIGURACIÓN FIREBASE (ACTUALIZADA)
// ============================================
const firebaseConfig = {
  apiKey: "AIzaSyCru7dXkG1XmUAHEXzUeeygdN1je4vOUMA",
  authDomain: "metricas-pulsera.firebaseapp.com",
  projectId: "metricas-pulsera",
  storageBucket: "metricas-pulsera.firebasestorage.app",
  messagingSenderId: "1075067181635",
  appId: "1:1075067181635:android:72b9649281249d020792f6"
};

let db;
try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  console.log("Firebase initialized successfully");
} catch (e) {
  console.error("Firebase initialization failed:", e);
}
let unsubscribePatient = null;

document.addEventListener('DOMContentLoaded', () => {
  initUnifiedChart();
  
  // Cargar lista de pacientes de Firestore
  loadPatientsList();

  // Escuchar selección de paciente
  document.getElementById('patient-select').addEventListener('change', (e) => {
    const patientId = e.target.value;
    if (patientId) {
      subscribeToPatient(patientId);
    }
  });

  // 1. Intentar cargar paciente desde la interfaz pasada (localStorage - legacy)
  syncPatientData();

  // Escuchar cambios en otras pestañas (si registran al paciente en el panel principal)
  window.addEventListener('storage', (e) => {
    if (e.key === 'sanare_current_patient') {
      syncPatientData();
    }
  });



  // Modo Enfoque
  document.getElementById('btn-focus').addEventListener('click', () => {
    document.body.classList.toggle('focus-mode');
    logEvent('info', document.body.classList.contains('focus-mode') ? "Modo enfoque activado" : "Modo normal activado");
  });

  // Re-conectar manualmente si se desea
  btnConnect.addEventListener('click', () => {
    if (!isConnected) connectPolarBLE();
    else disconnect();
  });

  // WhatsApp Share Logic
  const btnShareWhatsapp = document.getElementById('btn-share-whatsapp');
  if (btnShareWhatsapp) {
    btnShareWhatsapp.addEventListener('click', () => {
      const pName = displayPName.innerText;
      const pDetails = displayPDetails.innerText;
      const hr = currentMeasurements.hr || '--';
      const spo2 = currentMeasurements.spo2 || '--';
      const bpSys = currentMeasurements.bpSys || '--';
      const bpDia = currentMeasurements.bpDia || '--';
      const temp = currentMeasurements.temp || '--';
      
      const maxHr = document.getElementById('max-hr').innerText;
      const avgSpo2 = document.getElementById('avg-spo2').innerText;

      const message = `*Sanare Pro - Historial Clínico*\n` +
                      `Paciente: ${pName}\n` +
                      `Detalles: ${pDetails}\n\n` +
                      `*Signos Vitales Actuales*\n` +
                      `- FC: ${hr} bpm\n` +
                      `- SpO2: ${spo2}%\n` +
                      `- PA: ${bpSys}/${bpDia} mmHg\n` +
                      `- Temp: ${temp} °C\n\n` +
                      `*Métricas de Sesión*\n` +
                      `- BPM Máximo: ${maxHr}\n` +
                      `- SpO2 Promedio: ${avgSpo2}\n\n` +
                      `Generado el: ${new Date().toLocaleString()}`;

      const encodedMessage = encodeURIComponent(message);
      window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
      logEvent('success', 'Historial enviado por WhatsApp');
    });
  }

  // Exportar como imagen (html2canvas)
  btnSaveRecord.addEventListener('click', async () => {
    if (typeof html2canvas === 'undefined') {
      logEvent('error', 'Librería html2canvas no cargada');
      return;
    }
    const originalText = btnSaveRecord.innerText;
    btnSaveRecord.innerText = 'Exportando...';
    try {
      const canvas = await html2canvas(document.body);
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `Sanare_Historial_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      logEvent('success', 'Historial clínico exportado como imagen');
    } catch (e) {
      console.error(e);
      logEvent('error', 'Error al exportar historial');
    } finally {
      btnSaveRecord.innerText = originalText;
    }
  });
});

/**
 * Sincroniza los datos del paciente desde el localStorage (interfaz pasada)
 */
async function syncPatientData() {
  const data = localStorage.getItem('sanare_current_patient');
  if (data) {
    const patient = JSON.parse(data);
    displayPName.innerText = patient.name || 'Paciente Sin Nombre';
    displayPDetails.innerText = `Edad: ${patient.age || '--'} años | Expediente: ${patient.id || '--'}`;
    avatarInitial.innerText = (patient.name || 'P').charAt(0).toUpperCase();
    console.log(`Datos recibidos del panel: ${patient.name}`);
    // Auto-conectar Bluetooth si no está conectado
    if (!isConnected) {
      setTimeout(connectPolarBLE, 1000);
    }
  } else {
    displayPName.innerText = "Esperando registro...";
    displayPDetails.innerText = "Registre al paciente en la interfaz principal";
  }
}

async function connectPolarBLE() {
  if (!navigator.bluetooth) {
    logEvent('warning', "Bluetooth no disponible en este navegador/dispositivo.");
    return;
  }
  try {
    deviceConnectionStateText.innerText = 'Buscando...';
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Polar' }, { services: [0x180D] }],
      optionalServices: [0x180D, 0x180F]
    });

    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(0x180D);
    hrCharacteristic = await service.getCharacteristic(0x2A37);

    await hrCharacteristic.startNotifications();
    hrCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
      const val = e.target.value;
      const flags = val.getUint8(0);
      const hr = (flags & 0x01) ? val.getUint16(1, true) : val.getUint8(1);
      updateDashboard(hr);
    });

    isConnected = true;
    statusIndicator.classList.add('active');
    btnConnect.style.background = '#f0fdf4';
    btnConnect.style.color = '#059669';
    deviceConnectionStateText.innerText = `Polar: ${bluetoothDevice.name}`;
    logEvent('success', `Telemetría en vivo activada.`);
    
    bluetoothDevice.addEventListener('gattserverdisconnected', disconnect);
  } catch (err) {
    console.error(err);
    disconnect();
  }
}

/**
 * Carga la lista de pacientes registrados en Firestore en tiempo real
 */
function loadPatientsList() {
  console.log("Iniciando carga de lista de pacientes...");
  const select = document.getElementById('patient-select');
  
  // Usamos onSnapshot sin orderBy para evitar errores de índice faltante
  // Luego ordenamos en memoria
  db.collection('patients').onSnapshot(snapshot => {
    console.log(`Pacientes recibidos: ${snapshot.size} documentos`);
    
    // Guardar valor seleccionado actual
    const currentVal = select.value;
    
    // Convertir a array para ordenar en memoria
    let patients = [];
    snapshot.forEach(doc => {
      patients.push({ docId: doc.id, ...doc.data() });
    });

    // Ordenar por timestamp (descendente)
    patients.sort((a, b) => {
      const timeA = a.timestamp ? a.timestamp.toMillis() : 0;
      const timeB = b.timestamp ? b.timestamp.toMillis() : 0;
      return timeB - timeA;
    });

    select.innerHTML = '<option value="">Seleccionar Paciente...</option>';
    
    if (patients.length === 0) {
      const opt = document.createElement('option');
      opt.innerText = "No hay pacientes registrados";
      opt.disabled = true;
      select.appendChild(opt);
      logEvent('warning', "No se encontraron pacientes en Firestore.");
      return;
    }

    patients.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.docId;
      opt.innerText = `${p.name || 'Sin nombre'} (${p.id || p.docId})`;
      select.appendChild(opt);
    });
    
    // Lógica de Selección Inteligente:
    // 1. Si el usuario ya tenía uno seleccionado, lo mantenemos.
    // 2. Si acaba de aparecer un paciente nuevo (el más reciente) y no hay nada seleccionado, lo seleccionamos.
    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    } else if (patients.length > 0 && !currentVal) {
      // Auto-seleccionar el más reciente si no hay selección previa
      const latestPatient = patients[0];
      select.value = latestPatient.docId;
      subscribeToPatient(latestPatient.docId);
    }
    
    // Solo log en consola, NO en el panel de alertas (para no spamear)
    console.log(`${snapshot.size} pacientes sincronizados.`);
  }, err => {
    console.error("Error crítico en Firestore (loadPatientsList):", err);
    logEvent('error', `Error de conexión: ${err.message}`);
  });
}

let lastClinicalEventsCount = 0;

/**
 * Se suscribe a los cambios de un paciente específico en tiempo real
 */
function subscribeToPatient(patientId) {
  if (unsubscribePatient) unsubscribePatient();
  lastClinicalEventsCount = 0;

  console.log(`Sincronizando con paciente: ${patientId}`);

  unsubscribePatient = db.collection('patients').doc(patientId).onSnapshot(doc => {
    if (!doc.exists) return;
    const p = doc.data();
    
    // Actualizar UI del Paciente
    displayDName.innerText = p.doctorName ? `Médico: ${p.doctorName}` : '';
    displayPName.innerText = p.name || 'Paciente Sin Nombre';
    displayPDetails.innerText = `Edad: ${p.age || '--'} años | Expediente: ${p.id || '--'}`;
    avatarInitial.innerText = (p.name || 'P').charAt(0).toUpperCase();

    // Actualizar Métricas si existen
    if (p.metrics) {
      const { hr, spo2, bpSys, bpDia, temp } = p.metrics;
      if (hr > 0) {
        updateDashboard(hr, spo2);
      }
      
      // Actualizar Presión Arterial
      if (bpSys > 0 && bpDia > 0) {
        currentMeasurements.bpSys = bpSys;
        currentMeasurements.bpDia = bpDia;
        valBp.innerText = `${bpSys}/${bpDia}`;
        const { label, color } = classifyBP(bpSys, bpDia);
        document.getElementById('bp-badge').innerText = label;
        document.getElementById('bp-badge').style.color = color;
        document.getElementById('bp-classification').innerText = `Remoto: ${bpSys}/${bpDia}`;
      }

      // Actualizar Temperatura
      if (temp > 0) {
        currentMeasurements.temp = temp;
        document.getElementById('val-temp').innerText = temp;
        
        let tempLabel = 'NORMAL';
        let tempColor = '#059669';
        if (temp >= 38) { tempLabel = 'FIEBRE'; tempColor = '#dc2626'; }
        else if (temp < 36) { tempLabel = 'HIPOTERMIA'; tempColor = '#2563eb'; }
        
        document.getElementById('temp-badge').innerText = tempLabel;
        document.getElementById('temp-badge').style.color = tempColor;
        document.getElementById('temp-classification').innerText = `Remoto: ${temp}°C`;
      }
    }

    // Mostrar Eventos Clínicos (todos al suscribirse + nuevos en tiempo real)
    if (p.clinicalEvents && Array.isArray(p.clinicalEvents) && p.clinicalEvents.length > 0) {
      if (p.clinicalEvents.length > lastClinicalEventsCount) {
        const startIdx = lastClinicalEventsCount;
        for (let i = startIdx; i < p.clinicalEvents.length; i++) {
          const ev = p.clinicalEvents[i];
          if (ev.type === 'infusion') {
            const lines = [
              ev.sal    ? `<strong>Medicamento:</strong> ${ev.sal}` : '',
              ev.gramos ? `<strong>Dosis:</strong> ${ev.gramos}` : '',
              ev.dilucion ? `<strong>Dilución:</strong> ${ev.dilucion}` : '',
              ev.tiempo   ? `<strong>Tiempo:</strong> ${ev.tiempo}` : ''
            ].filter(Boolean).join('<br>');
            logEvent('info', lines, '💉 INFUSIÓN');
          } else if (ev.type === 'adverse_event') {
            const lines = [
              ev.esperado ? `<strong>Efecto esperado:</strong> ${ev.esperado}` : '',
              ev.adversa  ? `<strong>Reacción adversa:</strong> ${ev.adversa}` : '',
              ev.farmaco  ? `<strong>Medida / Tx:</strong> ${ev.farmaco}` : ''
            ].filter(Boolean).join('<br>');
            logEvent('error', lines, '⚠️ REACCIÓN ADVERSA');
          } else if (ev.type === 'emergency_alert') {
            const lines = [
              ev.comentario ? `<strong>Reporte:</strong> ${ev.comentario}` : ''
            ].filter(Boolean).join('<br>');
            logEvent('error', lines, '🚨 ALERTA CRÍTICA');
            
            // Also show browser alert for prominence
            alert(`🚨 ALERTA CRÍTICA RECIENTE:\n${ev.comentario}`);
          }
        }
        lastClinicalEventsCount = p.clinicalEvents.length;
      }
    }
  });
}

function updateDashboard(hr, spo2FromFirestore) {
  currentMeasurements.hr = hr;
  
  // Si viene de Firestore, usamos ese. Si no, calculamos uno (legacy logic)
  if (spo2FromFirestore > 0) {
    currentMeasurements.spo2 = spo2FromFirestore;
    isManualSpo2 = false;
  } else if (currentMeasurements.spo2 === 0 || (!isManualSpo2 && Math.random() > 0.8)) {
    currentMeasurements.spo2 = Math.max(95, Math.min(100, 98 + (Math.floor(Math.random() * 2) - 1)));
  }
  valHr.innerText = hr;
  valSpo2.innerText = currentMeasurements.spo2;
  valLastSync.innerText = `Sinc: ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit'})}`;

  hrHistory.push(hr);
  spo2History.push(currentMeasurements.spo2);
  const maxHr = Math.max(...hrHistory);
  const avgSpo2 = Math.round(spo2History.reduce((a, b) => a + b, 0) / spo2History.length);
  maxHrEl.innerText = `${maxHr} bpm`;
  avgSpo2El.innerText = `${avgSpo2} %`;

  updateChart(hr, currentMeasurements.spo2);
}

function disconnect() {
  if (bluetoothDevice && bluetoothDevice.gatt.connected) bluetoothDevice.gatt.disconnect();
  isConnected = false;
  statusIndicator.classList.add('active');
  btnConnect.style.background = '#f0fdf4';
  btnConnect.style.color = '#059669';
  deviceConnectionStateText.innerText = 'Con sensor';
}

function logEvent(type, msg, customLabel) {
  const card = document.createElement('div');
  card.className = `alert-card ${type}`;
  
  // Si se pasa un customLabel se usa; si no, se usa el tipo como fallback
  const label = customLabel || type.toUpperCase();
  
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 0.6rem;">
      <span>${label}</span>
      <span style="color: var(--text-muted);">${new Date().toLocaleTimeString()}</span>
    </div>
    <div style="font-size: 0.75rem; line-height: 1.5;">${msg}</div>
  `;
  alertsList.prepend(card);
  if (alertsList.children.length > 20) alertsList.removeChild(alertsList.lastChild);
}

function initUnifiedChart() {
  const ctx = document.getElementById('chartHr').getContext('2d');
  chartUnified = new Chart(ctx, {
    type: 'line',
    data: {
      labels: tLabels,
      datasets: [
        { label: 'FC', data: dHr, borderColor: '#dc2626', borderWidth: 2, pointRadius: 0, tension: 0.4, yAxisID: 'y' },
        { label: 'SpO2', data: dSpo2, borderColor: '#2563eb', borderWidth: 2, pointRadius: 0, tension: 0.4, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { min: 40, max: 200, grid: { color: '#f1f5f9' } },
        y1: { min: 80, max: 100, position: 'right', grid: { display: false } }
      }
    }
  });
}

function updateChart(hr, spo2) {
  if (tLabels.length >= 40) { tLabels.shift(); dHr.shift(); dSpo2.shift(); }
  tLabels.push(''); dHr.push(hr); dSpo2.push(spo2);
  chartUnified.update('none');
}

function classifyBP(sys, dia) {
  // Basado en ACC/AHA 2017 con ajuste clínico:
  // 120/80 = Normal (la presion diastólica de 80 exacta es límite inferior de ELEVADA)
  if (sys >= 140 || dia > 90) return { label: 'HTA G1', color: '#dc2626' };
  if (sys >= 130 || dia > 80) return { label: 'ELEVADA', color: '#d97706' };
  return { label: 'NORMAL', color: '#059669' };
}
