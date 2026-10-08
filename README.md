# Pulse PWA v3 — on-device logging + BLE sync

The ESP32 measures every 10 min and stores each reading **on the device**.
The phone does NOT need to be connected during measurements. When you open the
app and connect, it **pulls the whole log at once** and adds it to local history.

## BLE
- `0x180D / 0x2A37` — standard Heart Rate (live BPM + RR while connected)
- `7f3d0001-5a2b-4c6e-9f10-abc123def001` — custom log service
  - INFO (read): deviceNow(4) · count(2) · recSize(1) · interval_s(2)
  - CTRL (write): `0x01` dump all · `0x02` clear · `0x03` dump since(+4B secs)
  - DATA (notify): `[0xA1 header]` → 12-byte records → `[0xA2]`

Record (14 B, little-endian): `t(u32 s) bpm(u8) quality(u8) rmssd(u16) sdnn(u16) meanRr(u16) motion(u16 mg)`
(the app reads `recSize` from the header, so it stays compatible if the record grows.)

Device time is monotonic (survives deep sleep); on sync the app anchors it to
the phone clock, so history timestamps are real wall-clock time.

## Using it with Bluefy (iPhone)
Because Bluefy drops the BLE link in the background, live streaming can't log
unattended — that's why the device logs itself. Workflow:
1. Press the button on the ESP32 to wake it into sync mode.
2. Open this app (over HTTPS) in Bluefy, tap **Connect & sync**, pick `Pulse HRM`.
3. The whole backlog downloads in a couple of seconds into **History**.

## Accelerometer (LSM6DS3)
A second I2C bus (SDA=GPIO7, SCL=GPIO8) reads motion (milli-g) into every record,
so sleep is detected from **low motion + low heart rate**, not HR alone. INT1=GPIO5
wakes the ESP32 on movement. Standard Battery Service `0x180F` reports charge.

## Files
`index.html` · `app.js` · `style.css` · `manifest.webmanifest` · `icon.svg` · `sw.js`

## Running
Serve over HTTPS (or `http://localhost`). Web Bluetooth: Chrome (Android/desktop)
or Bluefy (iOS). History is stored in the browser (localStorage), on this device only.
