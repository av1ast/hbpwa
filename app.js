/* ============================================================
 * Pulse PWA — BLE live HR + on-device log sync + HRV history
 *
 * Пристрій (ESP32) вимірює кожні 10 хв і накопичує журнал у себе.
 * Телефону НЕ треба бути поруч під час вимірювань: при під'єднанні
 * застосунок викачує весь журнал одним махом і додає в історію.
 *
 * Сервіси:
 *   0x180D / 0x2A37 — живий HR (коли палець на сенсорі під час синхр.)
 *   7f3d0001-...    — власний сервіс журналу:
 *       INFO (read)   deviceNow(4) count(2) recSize(1) interval_s(2)
 *       CTRL (write)  0x01 dump all | 0x02 clear | 0x03 dump since(+4б)
 *       DATA (notify) [0xA1 header] -> записи(12Б) -> [0xA2]
 *
 * Запис (12Б, LE): t(u32 сек) bpm(u8) quality(u8) rmssd(u16) sdnn(u16) meanRr(u16)
 * Час пристрою монотонний; при синхр. прив'язуємо до годинника телефона.
 * Усе локально, нічого не надсилається.
 * ============================================================ */

'use strict';

// ---- BLE ----
const HR_SERVICE = 'heart_rate';                 // 0x180D
const HR_MEASUREMENT = 'heart_rate_measurement'; // 0x2A37
const LOG_SVC  = '7f3d0001-5a2b-4c6e-9f10-abc123def001';
const LOG_INFO = '7f3d0002-5a2b-4c6e-9f10-abc123def001';
const LOG_CTRL = '7f3d0003-5a2b-4c6e-9f10-abc123def001';
const LOG_DATA = '7f3d0004-5a2b-4c6e-9f10-abc123def001';

const CMD_DUMP_ALL = 0x01;
const CMD_CLEAR    = 0x02;

const REC_MIN = 12;            // мінімальний запис (без руху)
const MOTION_SLEEP_MG = 25;    // поріг "нерухомо" для сну, мg
const HIST_KEY = 'pulse.history.v3';
const SYNC_TIMEOUT_MS = 20000;

// ---- Live-HR параметри (для вікна синхронізації) ----
const RR_MIN_MS = 300, RR_MAX_MS = 2000, RR_ECTOPIC = 0.30;
const HRV_WINDOW = 60, CHART_WINDOW = 180;

// ---- Стан ----
const S = {
  device: null, hrChar: null, logCtrl: null, logData: null, logInfo: null,
  connected: false,
  lastRr: null, lastRrAccepted: false, nn: [], hrTrace: [],
  hist: [],            // [{ts, bpm, quality, rmssd, sdnn, meanRr}]
  histMetric: 'bpm',   // 'bpm' | 'rmssd'
  sync: null,          // активна сесія викачування
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const el = {
  bleDot: $('bleDot'), bpm: $('bpm'), state: $('state'), batt: $('batt'),
  rmssd: $('rmssd'), rr: $('rr'), signal: $('signal'),
  ring: $('ring'), range: $('range'), chart: $('chart'),
  histChart: $('histChart'), histList: $('histList'), histTitle: $('histTitle'),
  segBpm: $('segBpm'), segHrv: $('segHrv'),
  count: $('count'), avg: $('avg'), last: $('last'),
  connect: $('connect'), disconnect: $('disconnect'),
  clear: $('clear'), msg: $('msg'),
  recZone: $('recZone'), recRing: $('recRing'), recPct: $('recPct'),
  recHrv: $('recHrv'), recRhr: $('recRhr'), recSleep: $('recSleep'),
  recSleepQ: $('recSleepQ'), recNote: $('recNote'),
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ============================================================
// УТИЛІТИ
// ============================================================
function setMsg(t, err) { el.msg.textContent = t || ''; el.msg.classList.toggle('error', !!err); }
function setState(t, live) { el.state.textContent = t; document.querySelector('.live').classList.toggle('on', !!live); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'; }
function fmtDay(ts) { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }); }

// ============================================================
// ЖИВИЙ HR (0x2A37) — працює, якщо палець на сенсорі під час синхр.
// ============================================================
function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const hr16 = flags & 0x01, energy = flags & 0x08, rr = flags & 0x10;
  const contactSup = flags & 0x04, contactDet = flags & 0x02;
  let i = 1, bpm;
  if (hr16) { bpm = dv.getUint16(i, true); i += 2; } else { bpm = dv.getUint8(i); i += 1; }
  if (energy) i += 2;
  const rrs = [];
  if (rr) for (; i + 1 < dv.byteLength; i += 2) rrs.push(dv.getUint16(i, true) * 1000 / 1024);
  return { bpm, rrs, contact: contactSup ? !!contactDet : null };
}

function pushNN(rrMs) {
  if (rrMs < RR_MIN_MS || rrMs > RR_MAX_MS) { S.lastRrAccepted = false; return false; }
  let contig = false;
  if (S.lastRr != null) {
    if (Math.abs(rrMs - S.lastRr) / S.lastRr > RR_ECTOPIC) {
      S.lastRr = rrMs; S.lastRrAccepted = false; return false;
    }
    contig = S.lastRrAccepted;
  }
  S.nn.push({ v: rrMs, contig });
  if (S.nn.length > HRV_WINDOW) S.nn.shift();
  S.lastRr = rrMs; S.lastRrAccepted = true; return true;
}

function liveRMSSD() {
  const n = S.nn.length; if (n < 5) return null;
  let ssd = 0, p = 0;
  for (let k = 1; k < n; k++) { if (!S.nn[k].contig) continue; ssd += (S.nn[k].v - S.nn[k - 1].v) ** 2; p++; }
  return p >= 4 ? Math.sqrt(ssd / p) : null;
}

function onMeasurement(ev) {
  let p; try { p = parseHeartRate(ev.target.value); } catch (e) { return; }
  let accepted = false;
  for (const rr of p.rrs) if (pushNN(rr)) accepted = true;
  el.bpm.textContent = p.bpm > 0 ? p.bpm : '--';
  const rm = liveRMSSD();
  el.rmssd.textContent = rm != null ? Math.round(rm) : '--';
  const lastRr = S.nn.length ? S.nn[S.nn.length - 1].v : null;
  el.rr.textContent = lastRr != null ? Math.round(lastRr) : '--';
  el.signal.textContent = p.contact === false ? 'Poor' : (accepted ? 'Good' : (p.rrs.length ? 'Noisy' : 'OK'));
  if (p.bpm > 0) { S.hrTrace.push(p.bpm); if (S.hrTrace.length > CHART_WINDOW) S.hrTrace.shift(); }
  beatPulse(); drawLiveChart();
}

let pulseTimer = null;
function beatPulse() { el.ring.classList.add('beat'); clearTimeout(pulseTimer); pulseTimer = setTimeout(() => el.ring.classList.remove('beat'), 160); }

// ============================================================
// ВИКАЧУВАННЯ ЖУРНАЛУ (власний сервіс)
// ============================================================
function onLogData(ev) {
  const dv = ev.target.value, len = dv.byteLength;
  if (!S.sync) return;
  if (len === 9 && dv.getUint8(0) === 0xA1) {
    S.sync.deviceNow = dv.getUint32(2, true);
    S.sync.count = dv.getUint16(6, true);
    S.sync.anchor = Date.now();
    S.sync.recs = [];
  } else if (len === 1 && dv.getUint8(0) === 0xA2) {
    finalizeSync();
  } else if (len >= REC_MIN) {
    S.sync.recs.push({
      t: dv.getUint32(0, true),
      bpm: dv.getUint8(4),
      quality: dv.getUint8(5),
      rmssd: dv.getUint16(6, true),
      sdnn: dv.getUint16(8, true),
      meanRr: dv.getUint16(10, true),
      motion: len >= 14 ? dv.getUint16(12, true) : null, // поле руху (нові прошивки)
    });
  }
}

async function startSync() {
  if (!S.logCtrl || !S.logData) { setMsg('Цей пристрій не має журналу (лише живий HR).'); return; }
  S.sync = { deviceNow: null, count: 0, anchor: Date.now(), recs: [], done: false };
  setMsg('Синхронізація…');
  try {
    await S.logCtrl.writeValue(Uint8Array.of(CMD_DUMP_ALL));
  } catch (e) { setMsg('Помилка запиту журналу: ' + (e.message || e), true); S.sync = null; return; }
  clearTimeout(S.sync.timer);
  S.sync.timer = setTimeout(() => { if (S.sync && !S.sync.done) finalizeSync(true); }, SYNC_TIMEOUT_MS);
}

function finalizeSync(timedOut) {
  if (!S.sync || S.sync.done) return;
  S.sync.done = true;
  clearTimeout(S.sync.timer);
  const { deviceNow, anchor, recs, count } = S.sync;

  let added = 0;
  if (deviceNow != null) {
    for (const r of recs) {
      if (r.bpm === 0) continue;                   // немає контакту — пропускаємо
      const ts = anchor - (deviceNow - r.t) * 1000; // час пристрою -> реальний
      if (mergeReading({ ts, bpm: r.bpm, quality: r.quality, rmssd: r.rmssd, sdnn: r.sdnn, meanRr: r.meanRr, motion: r.motion })) added++;
    }
  }
  saveHistory(); renderHistory();
  const got = recs.length;
  if (deviceNow == null) setMsg('Синхронізація не вдалася — спробуй ще раз.', true);
  else setMsg(`Синхронізовано: +${added} нових (отримано ${got}/${count}${timedOut ? ', таймаут' : ''}).`);
  S.sync = null;
}

// ============================================================
// ІСТОРІЯ (localStorage), дедуплікація по хвилинному відрізку
// ============================================================
function mergeReading(r) {
  const bucket = Math.round(r.ts / 60000); // 1 хв
  const i = S.hist.findIndex((h) => Math.round(h.ts / 60000) === bucket);
  if (i >= 0) { S.hist[i] = r; return false; } // оновлюємо дубль (ре-синхр.), не рахуємо як новий
  S.hist.push(r); return true;
}

function saveHistory() {
  S.hist.sort((a, b) => a.ts - b.ts);
  if (S.hist.length > 2000) S.hist = S.hist.slice(-2000);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(S.hist)); } catch (e) {}
}
function loadHistory() {
  try { const r = localStorage.getItem(HIST_KEY); if (r) S.hist = JSON.parse(r) || []; } catch (e) { S.hist = []; }
}

// ============================================================
// РЕНДЕР ІСТОРІЇ
// ============================================================
function renderHistory() {
  const h = S.hist;
  el.count.textContent = h.length;
  if (h.length) {
    const avg = Math.round(h.reduce((s, x) => s + x.bpm, 0) / h.length);
    el.avg.textContent = avg;
    const lastItem = h[h.length - 1];
    el.last.textContent = `${fmtTime(lastItem.ts)} · ${lastItem.bpm}`;
  } else { el.avg.textContent = '--'; el.last.textContent = '--'; }

  // список останніх 12
  el.histList.innerHTML = '';
  const recent = h.slice(-12).reverse();
  for (const x of recent) {
    const row = document.createElement('div');
    row.className = 'hrow';
    row.innerHTML =
      `<span class="ht">${fmtDay(x.ts)} ${fmtTime(x.ts)}</span>` +
      `<span class="hb">${x.bpm}<em>bpm</em></span>` +
      `<span class="hv">${x.rmssd ? x.rmssd + ' ms' : '—'}</span>`;
    el.histList.appendChild(row);
  }
  drawHistChart();
  renderReadiness();
}

function drawHistChart() {
  const c = el.histChart, dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight; if (!w || !hgt) return;
  if (c.width !== w * dpr || c.height !== hgt * dpr) { c.width = w * dpr; c.height = hgt * dpr; }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, hgt);

  const key = S.histMetric;
  const pts = S.hist.filter((x) => key === 'bpm' ? x.bpm > 0 : x.rmssd > 0);
  el.histTitle.textContent = key === 'bpm' ? 'Resting BPM' : 'HRV (RMSSD)';
  if (pts.length < 2) { el.range.textContent = ''; return; }

  const xs = pts.map((p) => p.ts), ys = pts.map((p) => key === 'bpm' ? p.bpm : p.rmssd);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (max - min < 8) { const m = (max + min) / 2; min = m - 4; max = m + 4; }
  min = Math.floor(min - 2); max = Math.ceil(max + 2);
  const t0 = xs[0], t1 = xs[xs.length - 1], span = Math.max(1, t1 - t0);
  const pad = 10;
  const X = (t) => pad + ((t - t0) / span) * (w - 2 * pad);
  const Y = (v) => hgt - pad - ((v - min) / (max - min)) * (hgt - 2 * pad);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) { const gy = pad + (g / 3) * (hgt - 2 * pad); ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(w - pad, gy); ctx.stroke(); }

  const col = key === 'bpm' ? '#ff3d57' : '#4da3ff';
  const grad = ctx.createLinearGradient(0, 0, 0, hgt);
  grad.addColorStop(0, key === 'bpm' ? 'rgba(255,61,87,0.25)' : 'rgba(77,163,255,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(X(xs[0]), Y(ys[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(xs[i]), Y(ys[i]));
  ctx.lineTo(X(xs[xs.length - 1]), hgt - pad); ctx.lineTo(X(xs[0]), hgt - pad); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath(); ctx.moveTo(X(xs[0]), Y(ys[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(xs[i]), Y(ys[i]));
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  for (let i = 0; i < pts.length; i++) { ctx.beginPath(); ctx.arc(X(xs[i]), Y(ys[i]), 2, 0, 7); ctx.fillStyle = col; ctx.fill(); }
  el.range.textContent = `${min}–${max}`;
}

// ============================================================
// ГОТОВНІСТЬ (Recovery) + ОЦІНКА СНУ — з журналу
//   Recovery: HRV + пульс спокою відносно особистої базової лінії.
//   Сон: оцінка за нічним патерном пульсу (НЕ справжні стадії сну).
//   Усе — оцінки для самоконтролю, не медичні показники.
// ============================================================
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function isNight(ts) { const h = new Date(ts).getHours(); return h >= 21 || h <= 11; }

function dayHRV(arr) { return median(arr.filter((r) => r.rmssd > 0).map((r) => r.rmssd)); }
function dayRHR(arr) {                               // середнє найнижчих 10% пульсу
  const b = arr.map((r) => r.bpm).filter((v) => v > 0).sort((x, y) => x - y);
  if (!b.length) return null;
  const n = Math.max(1, Math.round(b.length * 0.1));
  let s = 0; for (let i = 0; i < n; i++) s += b[i];
  return s / n;
}

// Оцінка нічного сну з патерну пульсу
function estimateSleep(hist, rhr) {
  const now = Date.now();
  const pts = hist.filter((x) => x.ts >= now - 18 * 3600e3 && x.bpm > 0).sort((a, b) => a.ts - b.ts);
  if (pts.length < 4) return { found: false };
  const thr = (rhr || 60) * 1.15;
  const span = (r) => pts[r.end].ts - pts[r.start].ts;
  // "уві сні" = ніч + низький пульс + (якщо є акселерометр) мало руху
  const asleep = (p) => isNight(p.ts) && p.bpm <= thr &&
    (p.motion == null || p.motion <= MOTION_SLEEP_MG);
  let best = null, cur = null;
  const flush = () => { if (cur && (!best || span(cur) > span(best))) best = cur; };
  for (let i = 0; i < pts.length; i++) {
    if (asleep(pts[i])) {
      if (!cur) cur = { start: i, end: i };
      else if (pts[i].ts - pts[cur.end].ts <= 40 * 60e3) cur.end = i;   // паузи до 40 хв (неспокій)
      else { flush(); cur = { start: i, end: i }; }
    } else { flush(); cur = null; }
  }
  flush();
  if (!best) return { found: false };
  const durMs = span(best);
  if (durMs < 2 * 3600e3) return { found: false };                      // < 2 год — не сон
  const seg = pts.slice(best.start, best.end + 1);
  const hrv = median(seg.filter((r) => r.rmssd > 0).map((r) => r.rmssd));
  const motions = seg.map((r) => r.motion).filter((m) => m != null);
  const avgMotion = motions.length ? motions.reduce((a, b) => a + b, 0) / motions.length : null;
  // частка справді спокійних відрізків (для "неспокою")
  const restful = seg.length ? seg.filter((r) => r.motion == null || r.motion <= MOTION_SLEEP_MG).length / seg.length : null;
  return {
    found: true, mins: Math.round(durMs / 60e3),
    hrv: hrv ? Math.round(hrv) : null,
    avgMotion: avgMotion != null ? Math.round(avgMotion) : null,
    restful, hasMotion: motions.length > 0, end: pts[best.end].ts,
  };
}

function computeReadiness() {
  const h = S.hist;
  if (!h.length) return { baseDays: 0 };
  const byDay = new Map();
  for (const x of h) { const k = dayKey(x.ts); (byDay.get(k) || byDay.set(k, []).get(k)).push(x); }
  const keys = [...byDay.keys()];
  const todayKey = dayKey(Date.now());

  const prior = keys.filter((k) => k !== todayKey).slice(-14);
  const baseHRVs = prior.map((k) => dayHRV(byDay.get(k))).filter((v) => v != null);
  const baseRHRs = prior.map((k) => dayRHR(byDay.get(k))).filter((v) => v != null);
  const todayArr = byDay.get(todayKey) || [];
  const tHRV = dayHRV(todayArr), tRHR = dayRHR(todayArr);
  const baseDays = Math.min(baseHRVs.length, baseRHRs.length);

  const out = { baseDays, tHRV, tRHR, recovery: null, zone: null };
  let bHRV = baseHRVs.length ? baseHRVs.reduce((a, b) => a + b, 0) / baseHRVs.length : null;
  const bRHR = baseRHRs.length ? baseRHRs.reduce((a, b) => a + b, 0) / baseRHRs.length : null;

  if (baseDays >= 3 && tHRV != null && tRHR != null && bHRV && bRHR) {
    const sHRV = clamp(66 * (tHRV / bHRV), 0, 100);     // HRV вище базового -> краще
    const sRHR = clamp(66 * (bRHR / tRHR), 0, 100);     // пульс спокою нижче -> краще
    const rec = Math.round(0.7 * sHRV + 0.3 * sRHR);    // HRV важить більше
    out.recovery = clamp(rec, 0, 100);
    out.zone = rec >= 66 ? 'good' : (rec >= 34 ? 'mid' : 'low');
    out.baseHRV = Math.round(bHRV); out.baseRHR = Math.round(bRHR);
  }

  out.sleep = estimateSleep(h, tRHR || bRHR || 60);
  if (out.sleep.found && bHRV) {
    const durH = out.sleep.mins / 60;
    const sDur = clamp(durH / 7.5, 0, 1.1);
    const sHrv = clamp((out.sleep.hrv || bHRV) / bHRV, 0, 1.2);
    let q;
    if (out.sleep.hasMotion) {                 // є акселерометр -> врахувати спокій
      const sRest = clamp(out.sleep.restful || 0, 0, 1);
      q = 0.5 * sDur + 0.25 * sHrv + 0.25 * sRest;
    } else {
      q = 0.65 * sDur + 0.35 * sHrv;
    }
    out.sleep.quality = clamp(Math.round(q / 1.1 * 100), 0, 100);
  }
  return out;
}

function renderReadiness() {
  const r = computeReadiness();
  const zoneTxt = { good: 'Recovered', mid: 'Adequate', low: 'Low' };

  if (r.recovery != null) {
    el.recPct.textContent = r.recovery;
    el.recZone.textContent = zoneTxt[r.zone];
    el.recZone.className = 'zone ' + r.zone;
    const col = r.zone === 'good' ? 'var(--good)' : (r.zone === 'mid' ? '#ffb020' : 'var(--accent)');
    el.recRing.style.setProperty('--zone', col);
    el.recRing.style.background =
      `radial-gradient(closest-side, var(--bg-elev) 70%, transparent 71%), ` +
      `conic-gradient(${col} ${r.recovery}%, var(--line) 0%)`;
  } else {
    el.recPct.textContent = '--';
    el.recZone.textContent = '—'; el.recZone.className = 'zone';
    el.recRing.style.background =
      `radial-gradient(closest-side, var(--bg-elev) 70%, transparent 71%), ` +
      `conic-gradient(var(--line) 0%, var(--line) 100%)`;
  }

  el.recHrv.textContent = r.tHRV != null ? Math.round(r.tHRV) : '--';
  el.recRhr.textContent = r.tRHR != null ? Math.round(r.tRHR) : '--';

  if (r.sleep && r.sleep.found) {
    const hh = Math.floor(r.sleep.mins / 60), mm = r.sleep.mins % 60;
    el.recSleep.textContent = `${hh}h ${mm}m`;
    el.recSleepQ.textContent = r.sleep.quality != null ? `· ${r.sleep.quality}%` : '';
  } else { el.recSleep.textContent = '--'; el.recSleepQ.textContent = ''; }

  if (r.recovery == null) {
    el.recNote.textContent = `Збираю базову лінію (${r.baseDays || 0}/3 днів). Recovery з'явиться, коли назбирається кілька днів даних.`;
  } else {
    const sleepSrc = (r.sleep && r.sleep.found && r.sleep.hasMotion)
      ? 'Сон — за рухом + пульсом (акселерометр), оцінка.'
      : 'Сон — оцінка лише за нічним пульсом.';
    el.recNote.textContent = 'Оцінка готовності за HRV і пульсом спокою відносно твого базового рівня. '
      + sleepSrc + ' Це не медичні показники.';
  }
}

// ============================================================
// ЖИВИЙ ГРАФІК
// ============================================================
function drawLiveChart() {
  const c = el.chart, dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight; if (!w || !hgt) return;
  if (c.width !== w * dpr || c.height !== hgt * dpr) { c.width = w * dpr; c.height = hgt * dpr; }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, hgt);
  const d = S.hrTrace; if (d.length < 2) return;
  const pad = 10; let min = Math.min(...d), max = Math.max(...d);
  if (max - min < 10) { const m = (max + min) / 2; min = m - 5; max = m + 5; }
  min = Math.floor(min - 2); max = Math.ceil(max + 2);
  const X = (i) => pad + (i / (d.length - 1)) * (w - 2 * pad);
  const Y = (v) => hgt - pad - ((v - min) / (max - min)) * (hgt - 2 * pad);
  const grad = ctx.createLinearGradient(0, 0, 0, hgt);
  grad.addColorStop(0, 'rgba(255,61,87,0.28)'); grad.addColorStop(1, 'rgba(255,61,87,0)');
  ctx.beginPath(); ctx.moveTo(X(0), Y(d[0]));
  for (let i = 1; i < d.length; i++) ctx.lineTo(X(i), Y(d[i]));
  ctx.lineTo(X(d.length - 1), hgt - pad); ctx.lineTo(X(0), hgt - pad); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(X(0), Y(d[0]));
  for (let i = 1; i < d.length; i++) ctx.lineTo(X(i), Y(d[i]));
  ctx.strokeStyle = '#ff3d57'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

// ============================================================
// ПІДКЛЮЧЕННЯ
// ============================================================
async function connect() {
  if (!('bluetooth' in navigator)) {
    setMsg('Web Bluetooth недоступний. Chrome (Android/ПК) або Bluefy (iPhone), по HTTPS.', true);
    return;
  }
  try {
    setMsg('Пошук пристрою…');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
      optionalServices: [HR_SERVICE, LOG_SVC, 'battery_service'],
    });
    S.device = device;
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setMsg('Підключення…');
    const server = await device.gatt.connect();

    // Живий HR
    try {
      const hr = await server.getPrimaryService(HR_SERVICE);
      S.hrChar = await hr.getCharacteristic(HR_MEASUREMENT);
      await S.hrChar.startNotifications();
      S.hrChar.addEventListener('characteristicvaluechanged', onMeasurement);
    } catch (e) { S.hrChar = null; }

    // Сервіс журналу
    try {
      const log = await server.getPrimaryService(LOG_SVC);
      S.logInfo = await log.getCharacteristic(LOG_INFO);
      S.logCtrl = await log.getCharacteristic(LOG_CTRL);
      S.logData = await log.getCharacteristic(LOG_DATA);
      await S.logData.startNotifications();
      S.logData.addEventListener('characteristicvaluechanged', onLogData);
    } catch (e) { S.logCtrl = S.logData = null; }

    // Заряд акумулятора (стандартний Battery Service)
    try {
      const bs = await server.getPrimaryService('battery_service');
      const bc = await bs.getCharacteristic('battery_level');
      const showBatt = (p) => { el.batt.textContent = (p === 0xFF || p > 100) ? '—' : p + '%'; };
      showBatt((await bc.readValue()).getUint8(0));
      await bc.startNotifications();
      bc.addEventListener('characteristicvaluechanged', (e) => showBatt(e.target.value.getUint8(0)));
    } catch (e) { el.batt.textContent = '—'; }

    S.connected = true;
    el.bleDot.classList.remove('off'); el.bleDot.classList.add('on');
    el.connect.disabled = true; el.disconnect.disabled = false;
    setState('CONNECTED', true);

    await startSync();   // автоматично викачуємо журнал
  } catch (e) {
    if (e && e.name === 'NotFoundError') setMsg('Пристрій не вибрано.');
    else setMsg('Помилка підключення: ' + (e && e.message ? e.message : e), true);
    cleanup();
  }
}

function disconnect() {
  if (S.device && S.device.gatt && S.device.gatt.connected) S.device.gatt.disconnect();
  else onDisconnected();
}
function onDisconnected() { cleanup(); setState('NOT CONNECTED', false); setMsg('Відключено.'); }
function cleanup() {
  S.connected = false; S.hrChar = S.logCtrl = S.logData = null;
  S.lastRr = null; S.lastRrAccepted = false; S.sync = null;
  el.bleDot.classList.add('off'); el.bleDot.classList.remove('on');
  el.connect.disabled = false; el.disconnect.disabled = true;
}

// ============================================================
// СТАРТ
// ============================================================
el.connect.addEventListener('click', connect);
el.disconnect.addEventListener('click', disconnect);
el.clear.addEventListener('click', () => {
  if (!S.hist.length) return;
  S.hist = []; saveHistory(); renderHistory(); setMsg('Історію очищено (на телефоні).');
});
el.segBpm.addEventListener('click', () => setMetric('bpm'));
el.segHrv.addEventListener('click', () => setMetric('rmssd'));
window.addEventListener('resize', () => { drawLiveChart(); drawHistChart(); });

function setMetric(m) {
  S.histMetric = m;
  el.segBpm.classList.toggle('on', m === 'bpm');
  el.segHrv.classList.toggle('on', m === 'rmssd');
  drawHistChart();
}

if (!('bluetooth' in navigator))
  setMsg('Web Bluetooth недоступний. Відкрий по HTTPS у Chrome (Android/ПК) або Bluefy (iPhone).', true);

loadHistory();
renderHistory();
renderReadiness();

if ('serviceWorker' in navigator)
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
