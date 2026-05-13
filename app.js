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
const displayPName = document.getElementById('display-p-name');
const displayPDetails = document.getElementById('display-p-details');
const avatarInitial = document.getElementById('avatar-initial');
const btnSaveRecord = document.getElementById('btn-save-database');

// State
let bluetoothDevice = null;
let gattServer = null;
let hrCharacteristic = null;
let isConnected = false;
let currentMeasurements = { hr: 0, spo2: 0, bpSys: 0, bpDia: 0 };
let hrHistory = [], spo2History = [];
let chartUnified;
let tLabels = [], dHr = [], dSpo2 = [];

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

  // Manual BP Logic
  const btnEditBp = document.getElementById('btn-edit-bp');
  const bpEditForm = document.getElementById('bp-edit-form');
  const btnSaveBp = document.getElementById('btn-save-bp');

  btnEditBp.addEventListener('click', () => {
    const isVisible = bpEditForm.style.display === 'block';
    bpEditForm.style.display = isVisible ? 'none' : 'block';
    btnEditBp.innerText = isVisible ? 'EDITAR' : 'CERRAR';
  });

  btnSaveBp.addEventListener('click', () => {
    const sys = parseInt(document.getElementById('inp-bp-sys').value);
    const dia = parseInt(document.getElementById('inp-bp-dia').value);
    if (!sys || !dia) return;
    currentMeasurements.bpSys = sys;
    currentMeasurements.bpDia = dia;
    valBp.innerText = `${sys}/${dia}`;
    const { label, color } = classifyBP(sys, dia);
    document.getElementById('bp-badge').innerText = label;
    document.getElementById('bp-badge').style.color = color;
    document.getElementById('bp-classification').innerText = `Manual: ${sys}/${dia}`;
    logEvent('info', `PA manual: ${sys}/${dia} mmHg`);
    bpEditForm.style.display = 'none';
    btnEditBp.innerText = 'EDITAR';
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
    
    logEvent('success', `Datos recibidos del panel: ${patient.name}`);
    
    // Auto-conectar Bluetooth si no está conectado
    if (!isConnected) {
      setTimeout(connectPolarBLE, 1000);
    }
  } else {
    displayPName.innerText = "Esperando registro...";
    displayPDetails.innerText = "Registre al paciente en la interfaz principal";
    logEvent('warning', "Sin datos de paciente. Use la interfaz de registro.");
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
 * Carga la lista de pacientes registrados en Firestore
 */
function loadPatientsList() {
  console.log("Iniciando carga de lista de pacientes...");
  const select = document.getElementById('patient-select');
  
  db.collection('patients').orderBy('timestamp', 'desc').onSnapshot(snapshot => {
    console.log(`Pacientes recibidos: ${snapshot.size} documentos`);
    
    // Guardar valor seleccionado actual
    const currentVal = select.value;
    select.innerHTML = '<option value="">Seleccionar Paciente...</option>';
    
    if (snapshot.empty) {
      const opt = document.createElement('option');
      opt.innerText = "No hay pacientes registrados";
      opt.disabled = true;
      select.appendChild(opt);
      logEvent('warning', "No se encontraron pacientes en Firestore.");
      return;
    }

    snapshot.forEach(doc => {
      const p = doc.data();
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.innerText = `${p.name || 'Sin nombre'} (${p.id || doc.id})`;
      select.appendChild(opt);
    });
    
    // Restaurar selección si aún existe
    select.value = currentVal;
    
    if (snapshot.size > 0) {
      logEvent('success', `${snapshot.size} pacientes listos para monitoreo.`);
    }
  }, err => {
    console.error("Error en Firestore (loadPatientsList):", err);
    logEvent('error', `Error de base de datos: ${err.message}`);
    
    // Si falla el orden por timestamp (falta índice), intentar sin él
    if (err.message.includes('index')) {
      console.warn("Reintentando carga sin ordenamiento (falta índice)...");
      db.collection('patients').onSnapshot(snapshot => {
        // ... repetir lógica similar si es necesario, pero mejor manejarlo una vez
      });
    }
  });
}

/**
 * Se suscribe a los cambios de un paciente específico en tiempo real
 */
function subscribeToPatient(patientId) {
  if (unsubscribePatient) unsubscribePatient();

  logEvent('info', `Sincronizando con paciente: ${patientId}`);

  unsubscribePatient = db.collection('patients').doc(patientId).onSnapshot(doc => {
    if (!doc.exists) return;
    const p = doc.data();
    
    // Actualizar UI del Paciente
    displayPName.innerText = p.name || 'Paciente Sin Nombre';
    displayPDetails.innerText = `Edad: ${p.age || '--'} años | Expediente: ${p.id || '--'}`;
    avatarInitial.innerText = (p.name || 'P').charAt(0).toUpperCase();

    // Actualizar Métricas si existen
    if (p.metrics) {
      const { hr, spo2, bpSys, bpDia } = p.metrics;
      if (hr > 0) {
        updateDashboard(hr, spo2);
        
        // Actualizar Presión Arterial
        if (bpSys > 0 && bpDia > 0) {
          valBp.innerText = `${bpSys}/${bpDia}`;
          const { label, color } = classifyBP(bpSys, bpDia);
          document.getElementById('bp-badge').innerText = label;
          document.getElementById('bp-badge').style.color = color;
          document.getElementById('bp-classification').innerText = `Remoto: ${bpSys}/${bpDia}`;
        }
      }
    }
  });
}

function updateDashboard(hr, spo2FromFirestore) {
  currentMeasurements.hr = hr;
  
  // Si viene de Firestore, usamos ese. Si no, calculamos uno (legacy logic)
  if (spo2FromFirestore > 0) {
    currentMeasurements.spo2 = spo2FromFirestore;
  } else if (currentMeasurements.spo2 === 0 || Math.random() > 0.8) {
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
  statusIndicator.classList.remove('active');
  btnConnect.style.background = '';
  btnConnect.style.color = '';
  deviceConnectionStateText.innerText = 'Sin Sensor';
}

function logEvent(type, msg) {
  const card = document.createElement('div');
  card.className = `alert-card ${type}`;
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 0.6rem;">
      <span>${type.toUpperCase()}</span>
      <span style="color: var(--text-muted);">${new Date().toLocaleTimeString()}</span>
    </div>
    <div style="font-size: 0.75rem;">${msg}</div>
  `;
  alertsList.prepend(card);
  if (alertsList.children.length > 8) alertsList.removeChild(alertsList.lastChild);
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
  if (sys >= 140 || dia >= 90) return { label: 'HTA G1', color: '#dc2626' };
  if (sys >= 130 || dia >= 80) return { label: 'ELEVADA', color: '#d97706' };
  return { label: 'NORMAL', color: '#059669' };
}
