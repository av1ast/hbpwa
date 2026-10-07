# Pulse PWA v2 — BLE Heart Rate + HRV

Real UI + BLE logic. Connects to a standard Bluetooth **Heart Rate Service
(0x180D)** and subscribes to **Heart Rate Measurement (0x2A37)** notifications.
Heart rate and RR intervals are parsed on-device; **RMSSD / SDNN are computed
locally** from quality-filtered, consecutive RR intervals. No data leaves the
browser.

## Files
- `index.html` — markup (unchanged structure)
- `app.js` — Web Bluetooth connect, 0x2A37 parser, HRV, live chart, session
- `style.css` — dark wearable UI
- `manifest.webmanifest` + `icon.svg` — installable PWA
- `sw.js` — offline shell cache

## Running
Web Bluetooth needs a **secure context**: serve over **HTTPS** (or
`http://localhost`). Opening `index.html` as a `file://` works for the UI but
Bluetooth will be disabled.

Quick local test:
```
python3 -m http.server 8000
# open http://localhost:8000
```

Browsers with Web Bluetooth: Chrome / Edge on Android & desktop.
On **iPhone/iPad** Safari has no Web Bluetooth — use **Bluefy**.

## Signal quality
Uses the sensor-contact bit from 0x2A37 when the device reports it; otherwise
infers from RR stability. RR intervals outside 300–2000 ms, or jumping >30%
from the previous beat, are rejected and break the HRV chain so a single
artifact can't inflate RMSSD.

## Pairing with the ESP32 (MAX3010X) sketch
This app expects a standard Heart Rate GATT server. The MAX3010X sketch
currently prints over Serial — to use it here it needs a BLE Heart Rate
service (0x180D/0x2A37) advertising BPM (and optionally RR). Ask and I'll add
that server side.
