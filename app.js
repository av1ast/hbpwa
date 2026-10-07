/* ============================================================
 * Pulse PWA — BLE Heart Rate + HRV
 *
 * Джерело даних: стандартний BLE Heart Rate профіль
 *   Service  0x180D (Heart Rate)
 *   Char     0x2A37 (Heart Rate Measurement, notify)
 *
 * Працює з будь-яким датчиком, що рекламує цей профіль (нагрудні
 * ремені Polar/Garmin/Wahoo тощо), а також з ESP32, якщо він
 * підніме стандартний Heart Rate GATT-сервер.
 *
 * Якість понад усе: RR-інтервали чистяться (фізіологічні межі +
 * відсів ектопії), а RMSSD рахується ЛИШЕ з послідовних «чистих»
 * пар — будь-який пропуск розриває ланцюг, інакше артефакт дав би
 * фальшивий сплеск HRV. Уся обробка локальна, нічого не надсилається.
 * ============================================================ */

'use strict';

// ---- BLE UUID ----
const HR_SERVICE = 'heart_rate';                 // 0x180D
const HR_MEASUREMENT = 'heart_rate_measurement'; // 0x2A37

// ---- Параметри обробки ----
const RR_MIN_MS = 300;    // 200 BPM
const RR_MAX_MS = 2000;   // 30 BPM
const RR_ECTOPIC = 0.30;  // зміна > 30% від попереднього = ектопія/артефакт
const HRV_WINDOW = 60;    // к-сть останніх валідних NN для RMSSD/SDNN
const CHART_WINDOW = 180; // точок HR на графіку (~ час від к-сті ударів)
const STORE_KEY = 'pulse.session.v2';

// ---- Стан ----
const S = {
  device: null,
  char: null,
  connected: false,
  bpm: null,
  lastRr: null,          // попередній валідний RR (мс)
  lastRrAccepted: false, // чи попередній RR увійшов у ланцюг (для contiguity)
  nn: [],                // вікно валідних NN, мс  {v, contig}
  hrTrace: [],           // точки HR для графіка
  beats: 0,
  bpmSum: 0,
  avg: null,
  last: null,            // час останнього читання (ts)
  contact: null,         // статус контакту датчика (true/false/null)
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const el = {
  bleDot: $('bleDot'), bpm: $('bpm'), state: $('state'),
  rmssd: $('rmssd'), rr: $('rr'), signal: $('signal'),
  ring: $('ring'), range: $('range'), chart: $('chart'),
  count: $('count'), avg: $('avg'), last: $('last'),
  connect: $('connect'), disconnect: $('disconnect'),
  clear: $('clear'), msg: $('msg'),
};

// ============================================================
// УТИЛІТИ
// ============================================================

function fmtClock(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setMsg(text, isError) {
  el.msg.textContent = text || '';
  el.msg.classList.toggle('error', !!isError);
}

function setState(text, live) {
  el.state.textContent = text;
  document.querySelector('.live').classList.toggle('on', !!live);
}

// ============================================================
// ПАРСИНГ 0x2A37 (Heart Rate Measurement)
// ============================================================
// Повертає { bpm, rrs:[мс], contact:true|false|null }
function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const hr16 = flags & 0x01;          // bit0: формат ЧСС (0=uint8, 1=uint16)
  const contactSupported = flags & 0x04; // bit2
  const contactDetected = flags & 0x02;  // bit1
  const energyPresent = flags & 0x08;     // bit3
  const rrPresent = flags & 0x10;         // bit4

  let i = 1;
  let bpm;
  if (hr16) { bpm = dv.getUint16(i, true); i += 2; }
  else { bpm = dv.getUint8(i); i += 1; }

  if (energyPresent) i += 2; // пропускаємо Energy Expended

  const rrs = [];
  if (rrPresent) {
    for (; i + 1 < dv.byteLength; i += 2) {
      const raw = dv.getUint16(i, true);
      rrs.push((raw * 1000) / 1024); // одиниці 1/1024 с -> мс
    }
  }

  const contact = contactSupported ? !!contactDetected : null;
  return { bpm, rrs, contact };
}

// ============================================================
// ОБРОБКА RR -> HRV
// ============================================================

function pushNN(rrMs) {
  // 1) фізіологічні межі
  if (rrMs < RR_MIN_MS || rrMs > RR_MAX_MS) {
    S.lastRrAccepted = false; // розрив ланцюга
    return false;
  }
  // 2) відсів ектопії відносно попереднього валідного
  let contig = false;
  if (S.lastRr != null) {
    const delta = Math.abs(rrMs - S.lastRr) / S.lastRr;
    if (delta > RR_ECTOPIC) {
      // різкий стрибок: приймаємо як новий опорний, але ланцюг рвемо
      S.lastRr = rrMs;
      S.lastRrAccepted = false;
      return false;
    }
    contig = S.lastRrAccepted; // пара валідна лише якщо попередній теж прийнятий
  }

  S.nn.push({ v: rrMs, contig });
  if (S.nn.length > HRV_WINDOW) S.nn.shift();
  S.lastRr = rrMs;
  S.lastRrAccepted = true;
  return true;
}

// RMSSD і SDNN з вікна; RMSSD лише по послідовних (contig) парах
function computeHRV() {
  const n = S.nn.length;
  if (n < 5) return { rmssd: null, sdnn: null, n };

  let mean = 0;
  for (const x of S.nn) mean += x.v;
  mean /= n;

  let varSum = 0;
  for (const x of S.nn) varSum += (x.v - mean) ** 2;
  const sdnn = Math.sqrt(varSum / (n - 1));

  let ssd = 0, pairs = 0;
  for (let k = 1; k < n; k++) {
    if (!S.nn[k].contig) continue; // між цими ударами був розрив
    ssd += (S.nn[k].v - S.nn[k - 1].v) ** 2;
    pairs++;
  }
  const rmssd = pairs >= 4 ? Math.sqrt(ssd / pairs) : null;
  return { rmssd, sdnn, n, pairs };
}

function signalQuality(acceptedThisPacket, hadRr) {
  if (S.contact === false) return 'Poor';
  if (!hadRr) return S.contact === true ? 'OK' : '--';
  if (acceptedThisPacket) return 'Good';
  return 'Noisy';
}

// ============================================================
// ОНОВЛЕННЯ UI
// ============================================================

function onMeasurement(ev) {
  const dv = ev.target.value;
  let parsed;
  try { parsed = parseHeartRate(dv); }
  catch (e) { return; }

  S.bpm = parsed.bpm;
  S.contact = parsed.contact;
  S.last = Date.now();

  // RR -> HRV
  let accepted = false;
  const hadRr = parsed.rrs.length > 0;
  for (const rr of parsed.rrs) {
    if (pushNN(rr)) accepted = true;
  }

  // Статистика сесії (за ударами з валідним BPM)
  if (parsed.bpm > 0) {
    S.beats++;
    S.bpmSum += parsed.bpm;
    S.avg = S.bpmSum / S.beats;
    S.hrTrace.push(parsed.bpm);
    if (S.hrTrace.length > CHART_WINDOW) S.hrTrace.shift();
  }

  // DOM
  el.bpm.textContent = parsed.bpm > 0 ? parsed.bpm : '--';
  const hrv = computeHRV();
  el.rmssd.textContent = hrv.rmssd != null ? Math.round(hrv.rmssd) : '--';
  const lastRr = S.nn.length ? S.nn[S.nn.length - 1].v : null;
  el.rr.textContent = lastRr != null ? Math.round(lastRr) : '--';
  el.signal.textContent = signalQuality(accepted, hadRr);

  el.count.textContent = S.beats;
  el.avg.textContent = S.avg != null ? Math.round(S.avg) : '--';
  el.last.textContent = fmtClock(S.last);

  beatPulse();
  drawChart();
  saveSession();
}

// Пульсація кільця на кожен удар
let pulseTimer = null;
function beatPulse() {
  el.ring.classList.add('beat');
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => el.ring.classList.remove('beat'), 160);
}

// ============================================================
// ГРАФІК (canvas, rolling HR)
// ============================================================

function drawChart() {
  const c = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w * dpr || c.height !== h * dpr) {
    c.width = w * dpr; c.height = h * dpr;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = S.hrTrace;
  if (data.length < 2) {
    el.range.textContent = '—';
    return;
  }

  const pad = 10;
  let min = Math.min(...data), max = Math.max(...data);
  if (max - min < 10) { const m = (max + min) / 2; min = m - 5; max = m + 5; }
  min = Math.floor(min - 2); max = Math.ceil(max + 2);
  el.range.textContent = `${min}–${max} bpm`;

  const x = (i) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);

  // сітка
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const gy = pad + (g / 3) * (h - 2 * pad);
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(w - pad, gy); ctx.stroke();
  }

  // заливка під лінією
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,61,87,0.28)');
  grad.addColorStop(1, 'rgba(255,61,87,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]));
  ctx.lineTo(x(data.length - 1), h - pad);
  ctx.lineTo(x(0), h - pad);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // лінія
  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]));
  ctx.strokeStyle = '#ff3d57';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // остання точка
  const lx = x(data.length - 1), ly = y(data[data.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
}

// ============================================================
// ПІДКЛЮЧЕННЯ BLE
// ============================================================

async function connect() {
  if (!('bluetooth' in navigator)) {
    setMsg('Web Bluetooth не підтримується цим браузером. На iPhone скористайся Bluefy; на Android/desktop — Chrome.', true);
    return;
  }
  try {
    setMsg('Пошук пристрою…');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
      optionalServices: [HR_SERVICE],
    });
    S.device = device;
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setMsg('Підключення…');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(HR_SERVICE);
    const char = await service.getCharacteristic(HR_MEASUREMENT);
    S.char = char;

    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', onMeasurement);

    S.connected = true;
    el.bleDot.classList.remove('off');
    el.bleDot.classList.add('on');
    el.connect.disabled = true;
    el.disconnect.disabled = false;
    setState('CONNECTED', true);
    setMsg(device.name ? `Підключено: ${device.name}` : 'Підключено');
  } catch (e) {
    if (e && e.name === 'NotFoundError') setMsg('Пристрій не вибрано.');
    else setMsg('Помилка підключення: ' + (e && e.message ? e.message : e), true);
    cleanupConnection();
  }
}

function disconnect() {
  if (S.device && S.device.gatt && S.device.gatt.connected) {
    S.device.gatt.disconnect(); // спричинить onDisconnected
  } else {
    onDisconnected();
  }
}

function onDisconnected() {
  cleanupConnection();
  setState('NOT CONNECTED', false);
  setMsg('Відключено.');
}

function cleanupConnection() {
  S.connected = false;
  S.char = null;
  S.lastRr = null;
  S.lastRrAccepted = false;
  el.bleDot.classList.add('off');
  el.bleDot.classList.remove('on');
  el.connect.disabled = false;
  el.disconnect.disabled = true;
}

// ============================================================
// СЕСІЯ (localStorage)
// ============================================================

function saveSession() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      beats: S.beats, bpmSum: S.bpmSum, avg: S.avg,
      last: S.last, hrTrace: S.hrTrace.slice(-CHART_WINDOW),
    }));
  } catch (e) { /* приватний режим тощо — ігноруємо */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    S.beats = d.beats || 0;
    S.bpmSum = d.bpmSum || 0;
    S.avg = d.avg ?? null;
    S.last = d.last ?? null;
    S.hrTrace = Array.isArray(d.hrTrace) ? d.hrTrace : [];
    el.count.textContent = S.beats;
    el.avg.textContent = S.avg != null ? Math.round(S.avg) : '--';
    el.last.textContent = fmtClock(S.last);
    drawChart();
  } catch (e) { /* ignore */ }
}

function clearSession() {
  S.beats = 0; S.bpmSum = 0; S.avg = null; S.last = null;
  S.hrTrace = []; S.nn = [];
  el.count.textContent = '0';
  el.avg.textContent = '--';
  el.last.textContent = '--';
  el.rmssd.textContent = '--';
  el.rr.textContent = '--';
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  drawChart();
  setMsg('Сесію очищено.');
}

// ============================================================
// СТАРТ
// ============================================================

el.connect.addEventListener('click', connect);
el.disconnect.addEventListener('click', disconnect);
el.clear.addEventListener('click', clearSession);
window.addEventListener('resize', drawChart);

if (!('bluetooth' in navigator)) {
  setMsg('Web Bluetooth недоступний. Відкрий сайт по HTTPS у Chrome (Android/desktop) або Bluefy (iPhone).', true);
}

loadSession();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
