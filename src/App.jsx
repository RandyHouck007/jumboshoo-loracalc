import { useState, useEffect } from "react";

// ─── LoRa Airtime Formula (Semtech AN1200.13) ──────────────────────────────
function calcAirtime({ sf, bw, preamble, payloadBytes, cr, crc, explicitHeader, lowDROptimize }) {
  const DE = lowDROptimize ? 1 : 0;
  // SF6 on SX1276/RFM95W requires implicit header mode — explicit header not supported at SF6
  const IH = (sf === 6 || !explicitHeader) ? 1 : 0;
  const CRC = crc ? 1 : 0;
  const t_sym = (Math.pow(2, sf) / bw) * 1000; // ms
  const t_preamble = (preamble + 4.25) * t_sym;
  const inner = (8 * payloadBytes - 4 * sf + 28 + 16 * CRC - 20 * IH);
  const payload_sym_nb = 8 + Math.max(Math.ceil(inner / (4 * (sf - 2 * DE))) * (cr + 4), 0);
  const t_payload = payload_sym_nb * t_sym;
  return t_preamble + t_payload; // ms
}

// ─── TX Power → Current mapping (SX1262/SX1276 typical) ──────────────────
// RFM95W/96W/98W HopeRF datasheet v2.0, Table 5
// RFM95W / SX1276 HF band TX current (mA) — two PA paths:
// PA_BOOST (17, 20 dBm): direct from Table 5 (§2.4.5: SF12, CR4/6, BW125)
// RFO_HF (2–14 dBm):   linearly interpolated from Table 5 anchors
//   7 dBm/20 mA and 13 dBm/29 mA → slope 1.5 mA/dBm [est. ±2–3 mA]
//   14 dBm = PA_HF max per §5.4.2; 15 dBm per Table 31 register ceiling
// 15–16 dBm omitted — PA transition zone, current indeterminate
const TX_CURRENT = {
  2: 13, 5: 17, 8: 22, 11: 26, 14: 31, 17: 87, 20: 120,
};
const TX_POWER_OPTIONS = [2, 5, 8, 11, 14, 17, 20];

// ─── Presets ──────────────────────────────────────────────────────────────
const PRESETS = {
  heartbeat: {
    label: "Sensor Heartbeat",
    desc: "Node alive · battery voltage · temperature",
    sf: 12, bw: 125, payload: 12, cr: 2, txPower_eu: 14, txPower_us: 20,
  },
  status: {
    label: "Status Report",
    desc: "RPi diagnostics · sensor health metrics",
    sf: 12, bw: 125, payload: 24, cr: 2, txPower_eu: 14, txPower_us: 20,
  },
  detection: {
    label: "Detection Event",
    desc: "Seismic trigger · node ID + timestamp + amplitude",
    sf: 12, bw: 125, payload: 8, cr: 2, txPower_eu: 14, txPower_us: 20,
  },
  ping: {
    label: "Alive Ping",
    desc: "Minimal keepalive · lowest power",
    sf: 12, bw: 125, payload: 6, cr: 2, txPower_eu: 14, txPower_us: 20,
  },
  custom: { label: "Custom", sf: 12, bw: 125, payload: 12, cr: 2, txPower_eu: 14, txPower_us: 20 },
};

// ─── EU Sub-bands ──────────────────────────────────────────────────────────
const EU_BANDS = [
  { id: "g",  label: "g  868.0–868.6 MHz",  duty: 1   },
  { id: "g1", label: "g1 863.0–868.0 MHz",  duty: 1   },
  { id: "g2", label: "g2 868.7–869.2 MHz",  duty: 0.1 },
  { id: "g3", label: "g3 869.4–869.65 MHz", duty: 10  },
];

const fmt = (n, d = 2) => Number(n.toFixed(d)).toLocaleString();

export default function App() {
  const [region, setRegion] = useState("eu");
  const [preset, setPreset] = useState("heartbeat");
  const [sf, setSf] = useState(12);
  const [bw, setBw] = useState(125);
  const [payload, setPayload] = useState(12);
  const [cr, setCr] = useState(2);
  const [preamble, setPreamble] = useState(8);
  const [crc, setCrc] = useState(true);
  const [explicitHeader, setExplicitHeader] = useState(true);
  const [txPower, setTxPower] = useState(14);
  const [voltage, setVoltage] = useState(3.7);
  const [txIntervalMin, setTxIntervalMin] = useState(15);
  const [euBand, setEuBand] = useState("g");
  const [battCapacity, setBattCapacity] = useState(2000);
  const [ldrManual, setLdrManual] = useState(false);
  const [showCadNotes, setShowCadNotes] = useState(false);

  const tSym_ms = Math.pow(2, sf) / bw;
  const ldrRequired = tSym_ms > 16;
  const ldrOptimize = ldrRequired || ldrManual;

  // Apply preset
  useEffect(() => {
    if (preset === "custom") return;
    const p = PRESETS[preset];
    setSf(p.sf); setBw(p.bw); setPayload(p.payload); setCr(p.cr);
    setTxPower(region === "us" ? p.txPower_us : p.txPower_eu);
  }, [preset, region]);

  useEffect(() => {
    if (ldrRequired) setLdrManual(false);
  }, [ldrRequired]);

  const markCustom = () => setPreset("custom");

  const airtime = calcAirtime({ sf, bw: bw * 1000, preamble, payloadBytes: payload, cr, crc, explicitHeader, lowDROptimize: ldrOptimize });
  const current_mA = TX_CURRENT[txPower] ?? 31;
  const energy_mJ = (current_mA / 1000) * voltage * (airtime / 1000) * 1000;
  const energy_uAh = (current_mA * (airtime / 1000)) / 3.6;

  // EU duty cycle
  const euBandObj = EU_BANDS.find(b => b.id === euBand);
  const duty_limit = euBandObj?.duty ?? 1;
  const duty_used_per_tx = (airtime / 3_600_000) * 100;
  const tx_per_hour = txIntervalMin > 0 ? 60 / txIntervalMin : 0;
  const duty_used_per_hour = duty_used_per_tx * tx_per_hour;
  const duty_pct_of_limit = (duty_used_per_hour / duty_limit) * 100;
  const max_tx_per_hour = Math.floor((duty_limit / 100 * 3_600_000) / airtime);
  const min_interval_s = airtime / (duty_limit / 100) / 1000;

  // g vs g3 re-arm for current ToA (always derived, shown in EU card)
  const rearm_g_s  = airtime / 0.01 / 1000;   // 1% duty
  const rearm_g3_s = airtime / 0.10 / 1000;   // 10% duty

  // US dwell time
  const us_dwell_ok = airtime <= 400;

  // Battery life
  const tx_energy_per_day_mAh = (energy_uAh / 1000) * tx_per_hour * 24;
  const batt_days = tx_energy_per_day_mAh > 0 ? battCapacity / tx_energy_per_day_mAh : Infinity;

  const euCompliant = duty_used_per_hour <= duty_limit;
  const compliant = region === "eu" ? euCompliant : us_dwell_ok;

  const isDetection = preset === "detection";

  // ─── Configuration warnings ───────────────────────────────────────────────
  // Each: { level: "error"|"caution", label, message }
  const warnings = [];

  // W1 — BW500 on EU g3: physically impossible (sub-band only 250 kHz wide)
  if (region === "eu" && bw === 500 && euBand === "g3") {
    warnings.push({
      level: "error",
      label: "BW + Sub-band",
      message: "BW500 cannot fit in g3 — the sub-band is only 250 kHz wide (869.4–869.65 MHz). Use BW125 or switch sub-band.",
    });
  }
  // W2 — BW250 on EU g3: fills the entire slice with no frequency margin
  if (region === "eu" && bw === 250 && euBand === "g3") {
    warnings.push({
      level: "caution",
      label: "BW250 + g3",
      message: "BW250 fills the entire g3 slice with no frequency margin. BW125 recommended on g3.",
    });
  }
  // W3 — TX Power > 14 dBm on EU: exceeds ETSI EN 300 220 EIRP limit for all sub-bands
  if (region === "eu" && txPower > 14) {
    warnings.push({
      level: "error",
      label: "TX Power (EU)",
      message: `+${txPower} dBm exceeds EU EIRP limit of 14 dBm (25 mW) under ETSI EN 300 220. Reduce TX Power to ≤14 dBm.`,
    });
  }
  // W4 — TX Power = 20 dBm: RFM95W hardware duty-cycle restriction (any region)
  if (txPower === 20) {
    warnings.push({
      level: "caution",
      label: "+20 dBm duty limit",
      message: "RFM95W duty-cycle limited to 1% max at +20 dBm (Table 33, DC_20dBm). Continuous operation rated to +17 dBm.",
    });
  }
  // W5 — US dwell time exceeded
  if (region === "us" && !us_dwell_ok) {
    warnings.push({
      level: "error",
      label: "US Dwell Time",
      message: `ToA ${fmt(airtime, 1)} ms exceeds 400 ms FCC §15.247 dwell limit. Reduce SF, increase BW, or shorten payload.`,
    });
  }
  // W6 — EU g2 sub-band: 0.1% duty is extremely restrictive, rarely appropriate
  if (region === "eu" && euBand === "g2") {
    warnings.push({
      level: "caution",
      label: "g2 sub-band",
      message: "g2 duty cycle is 0.1% — 10× more restrictive than g/g1. Avoid for regular sensor TX unless legally required.",
    });
  }
  // W7 — Preamble < 8: risks sync failures (LoRaWAN specifies 8 minimum)
  if (preamble < 8) {
    warnings.push({
      level: "caution",
      label: "Preamble symbols",
      message: `Preamble ${preamble} symbols is below the LoRaWAN minimum of 8. Risk of sync failure, especially at range.`,
    });
  }
  // W8 — SF6 + explicit header: not supported on SX1276/RFM95W
  if (sf === 6 && explicitHeader) {
    warnings.push({
      level: "error",
      label: "SF6 + Explicit Header",
      message: "SF6 requires implicit header mode on SX1276/RFM95W — explicit header is not supported at SF6. Disable Explicit Header. Both sensor and brain must have payload length hardcoded in firmware.",
    });
  }

  const hasErrors   = warnings.some(w => w.level === "error");
  const hasCautions = warnings.some(w => w.level === "caution");

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0f1a12",
      color: "#d4e8d0",
      fontFamily: "'DM Mono', 'Courier New', monospace",
      padding: "0",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Instrument+Serif:ital@0;1&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { accent-color: #6fcf6f; width: 100%; cursor: pointer; }
        select, input[type=number] {
          background: #1a2e1c; border: 1px solid #2d4a30; color: #d4e8d0;
          padding: 6px 10px; border-radius: 4px; font-family: inherit;
          font-size: 13px; width: 100%; outline: none;
        }
        select:focus, input[type=number]:focus { border-color: #6fcf6f; }
        .toggle-btn {
          background: #1a2e1c; border: 1px solid #2d4a30; color: #8ab88a;
          padding: 5px 12px; border-radius: 3px; cursor: pointer;
          font-family: inherit; font-size: 12px; transition: all 0.15s;
        }
        .toggle-btn.active { background: #2a4a2c; border-color: #6fcf6f; color: #9fe89f; }
        .region-btn {
          padding: 8px 24px; border: 1px solid #2d4a30; background: #1a2e1c;
          color: #8ab88a; cursor: pointer; font-family: inherit; font-size: 13px;
          transition: all 0.15s; letter-spacing: 0.05em;
        }
        .region-btn:first-child { border-radius: 4px 0 0 4px; }
        .region-btn:last-child { border-radius: 0 4px 4px 0; }
        .region-btn.active { background: #3a6e3c; border-color: #6fcf6f; color: #c8f5c8; }
        .preset-chip {
          padding: 6px 14px; border: 1px solid #2d4a30; background: #1a2e1c;
          color: #8ab88a; cursor: pointer; font-family: inherit; font-size: 12px;
          border-radius: 20px; transition: all 0.15s; white-space: nowrap;
        }
        .preset-chip.active { background: #2a4a2c; border-color: #6fcf6f; color: #c8f5c8; }
        .preset-chip:hover { border-color: #5a9e5a; }
        .label { font-size: 11px; color: #5a8a5a; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 5px; }
        .value-big { font-family: 'Instrument Serif', serif; font-size: 42px; color: #9fe89f; line-height: 1; }
        .value-unit { font-size: 13px; color: #5a8a5a; margin-top: 3px; }
        .card { background: #131f15; border: 1px solid #1e3320; border-radius: 6px; padding: 20px; }
        .input-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
        .compliance-bar-bg { height: 8px; background: #1a2e1c; border-radius: 4px; overflow: hidden; margin: 8px 0; }
        hr { border: none; border-top: 1px solid #1e3320; margin: 14px 0; }
        .good { color: #6fcf6f; }
        .warning { color: #f0c060; }
        .danger { color: #e05050; }
        .footnote { font-size: 10px; color: #3a5a3a; font-style: italic; }
        .rearm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
        .rearm-box {
          background: #0d1a0f; border-radius: 4px; padding: 8px 10px;
          border: 1px solid #1a2e1c;
        }
        .rearm-box.g3 { border-color: #2a5a2c; background: #0d1f10; }
        .rearm-label { font-size: 10px; color: #4a7a4a; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 3px; }
        .rearm-val { font-size: 16px; color: #8ab88a; }
        .rearm-val.g3 { color: #6fcf6f; }
        .rearm-duty { font-size: 10px; color: #3a6a3a; margin-top: 1px; }
        .warn-row {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 8px 10px; border-radius: 4px; margin-bottom: 6px;
          font-size: 12px; line-height: 1.4;
        }
        .warn-row:last-child { margin-bottom: 0; }
        .warn-row.error   { background: #1f0a0a; border: 1px solid #5a1a1a; color: #f0a0a0; }
        .warn-row.caution { background: #1f1500; border: 1px solid #5a3a00; color: #f0c060; }
        .warn-row.ok      { background: #0a1f0d; border: 1px solid #1a5a1a; color: #6fcf6f; }
        .warn-badge {
          font-size: 10px; font-weight: bold; letter-spacing: 0.06em;
          padding: 1px 6px; border-radius: 3px; white-space: nowrap; margin-top: 1px;
          flex-shrink: 0;
        }
        .warn-badge.error   { background: #5a1a1a; color: #f0a0a0; }
        .warn-badge.caution { background: #5a3a00; color: #f0c060; }
        .warn-label { font-size: 10px; color: #5a7a5a; text-transform: uppercase;
                      letter-spacing: 0.07em; margin-bottom: 2px; }
      `}</style>

      {/* Header */}
      <div style={{ background: "#0a1409", borderBottom: "1px solid #1a2e1c", padding: "16px 24px" }}>
        <div style={{ maxWidth: "900px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <div style={{ fontSize: "18px", letterSpacing: "0.05em" }}>📡 Jumbo Shoo Project</div>
            <div style={{ fontSize: "11px", color: "#4a7a4a", marginTop: "2px" }}>LoRa Airtime & Compliance Calculator · Semtech AN1200.13 · EU ETSI EN 300 220 · US FCC §15.247</div>
            <div style={{ fontSize: "10px", color: "#3a6a5a", marginTop: "3px", fontStyle: "italic" }}>
              Single-sensor model — all calculations assume one node transmitting independently.
              Multi-sensor array notes (CAD backoff, channel staggering) are documented in the Excel Profiles tab.
            </div>
          </div>
          <div style={{ display: "flex" }}>
            {["eu", "us"].map(r => (
              <button key={r} className={`region-btn ${region === r ? "active" : ""}`}
                onClick={() => setRegion(r)}>
                {r === "eu" ? "EU 868 MHz" : "US 915 MHz"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "24px 16px", display: "grid", gridTemplateColumns: "320px 1fr", gap: "20px", alignItems: "start" }}>

        {/* ── LEFT COLUMN — Inputs ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Presets */}
          <div className="card">
            <div className="label">Profile</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
              {Object.entries(PRESETS).map(([key, p]) => (
                <button key={key} className={`preset-chip ${preset === key ? "active" : ""}`}
                  onClick={() => setPreset(key)}>
                  {p.label}
                </button>
              ))}
            </div>
            {PRESETS[preset]?.desc && (
              <div style={{ fontSize: "11px", color: "#4a7a4a", fontStyle: "italic" }}>
                {PRESETS[preset].desc}
              </div>
            )}
          </div>

          {/* RF Parameters */}
          <div className="card">
            <div className="label">RF Parameters</div>
            <div className="input-row">
              <div>
                <div className="label">Spreading Factor</div>
                <select value={sf} onChange={e => { setSf(+e.target.value); markCustom(); }}>
                  {[6,7,8,9,10,11,12].map(v => <option key={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Bandwidth</div>
                <select value={bw} onChange={e => { setBw(+e.target.value); markCustom(); }}>
                  {[125,250,500].map(v => <option key={v} value={v}>{v} kHz</option>)}
                </select>
              </div>
            </div>
            <div className="input-row">
              <div>
                <div className="label">Coding Rate</div>
                <select value={cr} onChange={e => { setCr(+e.target.value); markCustom(); }}>
                  {[1,2,3,4].map(v => <option key={v} value={v}>4/{v+4}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Payload (bytes)</div>
                <input type="number" min={1} max={255} value={payload}
                  onChange={e => { setPayload(+e.target.value); markCustom(); }} />
              </div>
            </div>
            <div className="input-row">
              <div>
                <div className="label">Preamble Symbols</div>
                <input type="number" min={6} max={65535} value={preamble}
                  onChange={e => { setPreamble(+e.target.value); markCustom(); }} />
              </div>
              <div>
                <div className="label">TX Power (dBm)</div>
                <select value={txPower} onChange={e => { setTxPower(+e.target.value); markCustom(); }}>
                  {TX_POWER_OPTIONS.filter(p => region === "us" || p <= 14).map(v =>
                    <option key={v} value={v}>{v} dBm · {TX_CURRENT[v]} mA</option>)}
                </select>
                {txPower === 20 && (
                  <div style={{ fontSize: "10px", color: "#f0a060", marginTop: "4px", fontStyle: "italic" }}>
                    ⚠ +20 dBm: duty-cycle limited to 1% max (RFM95W Table 33). Continuous use: 17 dBm.
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
              {[
                ["CRC", crc, setCrc],
                ["Explicit Hdr", explicitHeader, setExplicitHeader],
              ].map(([label, val, setter]) => (
                <button key={label} className={`toggle-btn ${val ? "active" : ""}`}
                  onClick={() => { setter(!val); markCustom(); }}>
                  {label}: {val ? "ON" : "OFF"}
                </button>
              ))}
              <button className={`toggle-btn ${ldrOptimize ? "active" : ""}`}
                disabled={ldrRequired}
                onClick={() => { if (!ldrRequired) { setLdrManual(!ldrManual); markCustom(); } }}>
                LDRO: {ldrOptimize ? "ON" : "OFF"}{ldrRequired ? " (auto)" : ""}
              </button>
            </div>
            {sf === 6 && (
              <div style={{ fontSize: "10px", color: "#f0a060", marginTop: "2px", fontStyle: "italic", lineHeight: "1.5" }}>
                ⚠ SF6: implicit header mode is enforced automatically in calculations (SX1276 hardware constraint).
                Explicit Hdr setting is ignored for SF6 — disable it to clear the W8 violation.
                SF6 also requires sync word 0x65 (vs 0x12 for SF7–12) and has ~5 dB less link margin than SF7.
              </div>
            )}

          </div>

          {/* Region-specific */}
          <div className="card">
            {region === "eu" ? (
              <>
                <div className="label">EU Sub-band</div>
                <select value={euBand} onChange={e => setEuBand(e.target.value)}>
                  {EU_BANDS.map(b => <option key={b.id} value={b.id}>{b.label} — {b.duty}%</option>)}
                </select>
              </>
            ) : (
              <div style={{ fontSize: "11px", color: "#4a7a4a" }}>
                FCC §15.247 — FHSS, ≥50 channels, max 400 ms dwell per channel.
              </div>
            )}
          </div>

          {/* Power & Battery */}
          <div className="card">
            <div className="label">Power & Battery</div>
            <div className="input-row" style={{ marginBottom: "8px" }}>
              <div>
                <div className="label">Voltage (V)</div>
                <input type="number" min={1.8} max={5} step={0.1} value={voltage}
                  onChange={e => setVoltage(+e.target.value)} />
              </div>
              <div>
                <div className="label">Capacity (mAh)</div>
                <input type="number" min={100} max={50000} step={100} value={battCapacity}
                  onChange={e => setBattCapacity(+e.target.value)} />
              </div>
            </div>
            <div className="label">TX Interval — <span style={{ color: "#9fe89f" }}>{txIntervalMin} min</span></div>
            <input type="range" min={0.5} max={360} step={0.5} value={txIntervalMin}
              onChange={e => setTxIntervalMin(+e.target.value)} />
          </div>

        </div>

        {/* ── RIGHT COLUMN — Results ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Compliance banner */}
          <div style={{
            padding: "14px 20px", borderRadius: "6px",
            background: compliant ? "#0d2010" : "#200d0d",
            border: `1px solid ${compliant ? "#2a5a2c" : "#5a2a2a"}`,
          }}>
            <div style={{ fontSize: "18px", color: compliant ? "#6fcf6f" : "#e05050", marginBottom: "4px" }}>
              {compliant ? "✓ COMPLIANT" : "✗ BREACH"}
            </div>
            <div style={{ fontSize: "12px", color: compliant ? "#4a8a4a" : "#8a4a4a" }}>
              {region === "eu"
                ? (euCompliant ? `EU duty cycle compliant — ${euBandObj?.label}` : "EU DUTY CYCLE EXCEEDED — reduce TX rate or switch sub-band")
                : (us_dwell_ok ? "US dwell time compliant (≤400 ms)" : "EXCEEDS 400 ms max dwell time")}
            </div>
            <div style={{ fontSize: "11px", color: "#5a7a5a", marginTop: "2px" }}>
              {region === "eu"
                ? `Using ${fmt(duty_used_per_hour, 3)}% of ${duty_limit}% — ${fmt(duty_pct_of_limit, 1)}% of budget consumed`
                : `Time on air: ${fmt(airtime, 1)} ms ${us_dwell_ok ? "< 400 ms ✓" : "— REDUCE SF or payload"}`}
            </div>
          </div>

          {/* ── Configuration Warnings ── */}
          <div className="card" style={{ padding: "16px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: warnings.length ? "12px" : "0" }}>
              <div className="label" style={{ marginBottom: 0 }}>Configuration Warnings</div>
              {!hasErrors && !hasCautions && (
                <span style={{ fontSize: "11px", color: "#6fcf6f" }}>✓ All checks passed</span>
              )}
              {hasErrors && (
                <span style={{ fontSize: "11px", color: "#e05050" }}>● {warnings.filter(w => w.level === "error").length} violation{warnings.filter(w => w.level === "error").length > 1 ? "s" : ""}</span>
              )}
              {!hasErrors && hasCautions && (
                <span style={{ fontSize: "11px", color: "#f0c060" }}>● {warnings.filter(w => w.level === "caution").length} caution{warnings.filter(w => w.level === "caution").length > 1 ? "s" : ""}</span>
              )}
            </div>
            {warnings.length === 0 && (
              <div className="warn-row ok">
                <span className="warn-badge ok" style={{ background: "#1a5a1a", color: "#6fcf6f" }}>OK</span>
                <span>No violations or cautions for current configuration.</span>
              </div>
            )}
            {warnings.map((w, i) => (
              <div key={i} className={`warn-row ${w.level}`}>
                <div style={{ flexShrink: 0, minWidth: "80px" }}>
                  <span className={`warn-badge ${w.level}`}>
                    {w.level === "error" ? "✗ VIOLATION" : "⚠ CAUTION"}
                  </span>
                  <div className="warn-label" style={{ marginTop: "4px", color: w.level === "error" ? "#7a3a3a" : "#7a5a00" }}>
                    {w.label}
                  </div>
                </div>
                <span>{w.message}</span>
              </div>
            ))}
          </div>

          {/* ── Scope & Multi-sensor Notes ── */}
          <div style={{
            background: "#0d1a2a", border: "1px solid #1a3a5a", borderRadius: "6px", padding: "14px 16px",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: "11px", color: "#4a8aaa", fontStyle: "italic" }}>
                ℹ  Single-sensor model — all calculations assume one node transmitting independently.
              </div>
              <button
                onClick={() => setShowCadNotes(v => !v)}
                style={{
                  background: "transparent", border: "1px solid #1a3a5a", color: "#4a8aaa",
                  fontSize: "10px", padding: "3px 10px", borderRadius: "3px", cursor: "pointer",
                  fontFamily: "inherit", whiteSpace: "nowrap", marginLeft: "12px",
                }}>
                {showCadNotes ? "▲ hide" : "▼ multi-sensor notes"}
              </button>
            </div>

            {showCadNotes && (
              <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>

                <div style={{ fontSize: "11px", color: "#6aaaca", borderBottom: "1px solid #1a3a5a", paddingBottom: "8px" }}>
                  The following is for reference only — future consideration if multiple sensors are deployed.
                  It does not affect any calculation in this tool.
                </div>

                {/* Why it matters */}
                <div>
                  <div style={{ fontSize: "10px", color: "#3a6a8a", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "4px" }}>Why concurrent transmissions are a problem in arrays</div>
                  <div style={{ fontSize: "11px", color: "#8ab0c8", lineHeight: "1.5" }}>
                    Seismic waves travel at 100–500 m/s through soil. Across a 100 m sensor array, all nodes
                    may trigger within 200 ms–1 s of each other — near-simultaneously from a radio perspective.
                    At SF7 (39 ms ToA), multiple sensors transmitting at the same time causes the brain module
                    to receive only the strongest signal (<em>capture effect</em>), silently discarding all others.
                    For time-of-arrival localisation this is a fatal bias, not just packet loss.
                  </div>
                </div>

                {/* CAD backoff algorithm */}
                <div style={{ background: "#0a1520", border: "1px solid #1a3050", borderRadius: "4px", padding: "10px 12px" }}>
                  <div style={{ fontSize: "10px", color: "#3a6a8a", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "6px" }}>
                    CAD backoff algorithm — detection events only
                    <span style={{ color: "#2a5a6a", marginLeft: "8px", textTransform: "none", letterSpacing: 0 }}>
                      (Hoang et al., Procedia Computer Science 177, 2020, Table 1)
                    </span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#6aaaca", lineHeight: "1.6" }}>
                    At SF7 / BW125 / CR4:5 — Tsym 1.024 ms · CAD ≈ 1.97 ms · Preamble 12.54 ms · MaxDelayCnt = 6 · Max delay 11.82 ms
                  </div>
                  <ol style={{ fontSize: "11px", color: "#8ab0c8", lineHeight: "1.7", paddingLeft: "18px", marginTop: "6px" }}>
                    <li>Threshold crossing detected</li>
                    <li>Draw random integer N in [0, 5]</li>
                    <li>Wait N × 1.97 ms</li>
                    <li>Execute CAD — check if channel active (RFM95W native CAD mode)</li>
                    <li>If busy: increment attempt; if attempts &lt; 4, wait one slot then go to step 2</li>
                    <li>If idle: transmit</li>
                    <li>After 4 failed attempts: log locally as undelivered, resume listening</li>
                  </ol>
                  <div style={{ fontSize: "10px", color: "#2a5a6a", marginTop: "6px", fontStyle: "italic" }}>
                    Constraint satisfied: max delay (11.82 ms) &lt; preamble (12.54 ms) — deferred node correctly
                    detects the winning node's preamble via CAD before its own backoff expires.
                  </div>
                </div>

                {/* Scheduled traffic */}
                <div style={{ fontSize: "11px", color: "#8ab0c8", lineHeight: "1.5" }}>
                  <span style={{ color: "#4a8aaa", fontWeight: "bold" }}>Heartbeat / Status / Ping — no backoff needed.</span>{" "}
                  Stagger scheduled transmissions by node ID at the application layer. CAD backoff applies only to
                  event-driven detection transmissions.
                </div>

                {/* Channel staggering */}
                <div style={{ fontSize: "11px", color: "#8ab0c8", lineHeight: "1.5" }}>
                  <span style={{ color: "#4a8aaa", fontWeight: "bold" }}>Channel staggering (EU g3) — more effective than MAC alone.</span>{" "}
                  g3's 250 kHz slice fits two non-overlapping BW125 channels. Assign sensors most likely to
                  co-trigger (geographically adjacent) to different channels. Doubles throughput with zero firmware complexity.
                  Combine with CAD backoff for dense arrays.
                </div>

              </div>
            )}
          </div>

          {/* Time on Air */}
          <div className="card">
            <div className="label">Time on Air</div>
            <div className="value-big">{airtime < 1000 ? fmt(airtime, 1) : fmt(airtime / 1000, 3)}</div>
            <div className="value-unit">{airtime < 1000 ? "milliseconds" : "seconds"}</div>
            <hr />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <div className="label">Symbol Duration</div>
                <div style={{ color: "#8ab88a", fontSize: "14px" }}>{fmt((Math.pow(2, sf) / (bw * 1000)) * 1000, 2)} ms</div>
              </div>
              <div>
                <div className="label">Bitrate (effective)</div>
                <div style={{ color: "#8ab88a", fontSize: "14px" }}>{fmt(sf * (4 / (4 + cr)) * bw * 1000 / Math.pow(2, sf) / 1000, 2)} kbps</div>
              </div>
            </div>
          </div>

          {/* Duty Cycle Detail (EU) */}
          {region === "eu" && (
            <div className="card">
              <div className="label">Duty Cycle Analysis</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                <div>
                  <div className="label">Limit ({euBandObj?.id})</div>
                  <div style={{ fontSize: "20px", color: "#9fe89f", fontFamily: "'Instrument Serif', serif" }}>{duty_limit}%</div>
                </div>
                <div>
                  <div className="label">Used / hour</div>
                  <div style={{ fontSize: "20px", fontFamily: "'Instrument Serif', serif" }}
                    className={duty_pct_of_limit > 90 ? "danger" : duty_pct_of_limit > 70 ? "warning" : "good"}>
                    {fmt(duty_used_per_hour, 4)}%
                  </div>
                </div>
              </div>
              <div className="compliance-bar-bg">
                <div style={{
                  width: `${Math.min(duty_pct_of_limit, 100)}%`, height: "100%",
                  background: duty_pct_of_limit > 90 ? "#e05050" : duty_pct_of_limit > 70 ? "#f0a060" : "#6fcf6f",
                  borderRadius: "4px", transition: "width 0.3s"
                }} />
              </div>
              <div style={{ fontSize: "11px", color: "#4a7a4a", marginTop: "4px" }}>
                {fmt(duty_pct_of_limit, 1)}% of budget used
              </div>
              <hr />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <div className="label">Max TX / hour</div>
                  <div style={{ color: "#8ab88a", fontSize: "16px" }}>{max_tx_per_hour.toLocaleString()}</div>
                </div>
                <div>
                  <div className="label">Min TX interval</div>
                  <div style={{ color: "#8ab88a", fontSize: "16px" }}>{`${fmt(min_interval_s, 1)} s`}</div>
                </div>
              </div>

              {/* g vs g3 re-arm comparison — always live for current ToA */}
              <hr />
              <div className="label" style={{ marginBottom: "6px" }}>
                Sensor re-arm · g vs g3{isDetection ? " — detection channel" : ""}
              </div>
              <div className="rearm-row">
                <div className="rearm-box">
                  <div className="rearm-label">g / g1  (1%)</div>
                  <div className="rearm-val">{fmt(rearm_g_s, 1)} s</div>
                  <div className="rearm-duty">{Math.floor(3600 / rearm_g_s).toLocaleString()} events / hr max</div>
                </div>
                <div className="rearm-box g3">
                  <div className="rearm-label">g3  (10%) ★</div>
                  <div className="rearm-val g3">{fmt(rearm_g3_s, 2)} s</div>
                  <div className="rearm-duty">{Math.floor(3600 / rearm_g3_s).toLocaleString()} events / hr max</div>
                </div>
              </div>
              {isDetection && (
                <div className="footnote" style={{ marginTop: "8px" }}>
                  ★ g3 recommended for detection channel — 10× faster re-arm. BW limited to 125 kHz on EU g3 (250 kHz slice).
                </div>
              )}
            </div>
          )}

          {/* US Dwell Detail */}
          {region === "us" && (
            <div className="card">
              <div className="label">FCC §15.247 — Dwell Time</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <div className="label">Time on Air</div>
                  <div style={{ fontSize: "20px", fontFamily: "'Instrument Serif', serif" }} className={us_dwell_ok ? "good" : "danger"}>
                    {fmt(airtime, 1)} ms
                  </div>
                </div>
                <div>
                  <div className="label">Max Dwell Limit</div>
                  <div style={{ fontSize: "20px", color: "#9fe89f", fontFamily: "'Instrument Serif', serif" }}>400 ms</div>
                </div>
              </div>
              <div className="compliance-bar-bg">
                <div style={{
                  width: `${Math.min((airtime / 400) * 100, 100)}%`, height: "100%",
                  background: !us_dwell_ok ? "#e05050" : airtime > 300 ? "#f0a060" : "#6fcf6f",
                  borderRadius: "4px", transition: "width 0.3s"
                }} />
              </div>
              <div style={{ fontSize: "11px", color: "#4a7a4a", marginTop: "4px" }}>
                {fmt((airtime / 400) * 100, 1)}% of 400 ms limit · No per-channel duty cycle — FHSS with ≥50 channels required
              </div>
            </div>
          )}

          {/* Energy */}
          <div className="card">
            <div className="label">Energy per Transmission</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <div className="label">Energy (mJ)</div>
                <div className="value-big" style={{ fontSize: "32px" }}>{fmt(energy_mJ, 3)}</div>
                <div className="value-unit">millijoules</div>
              </div>
              <div>
                <div className="label">Charge (µAh)</div>
                <div className="value-big" style={{ fontSize: "32px" }}>{fmt(energy_uAh, 3)}</div>
                <div className="value-unit">micro-amp-hours</div>
              </div>
            </div>
            <hr />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
              <div>
                <div className="label">TX Current</div>
                <div style={{ color: "#8ab88a", fontSize: "13px" }}>{current_mA} mA @ +{txPower} dBm</div>
              </div>
              <div>
                <div className="label">mAh / day (TX only)</div>
                <div style={{ color: "#8ab88a", fontSize: "13px" }}>{fmt(tx_energy_per_day_mAh, 3)} mAh</div>
              </div>
              <div>
                <div className="label">Battery Life (TX only)</div>
                <div style={{ color: batt_days < 180 ? "#f0a060" : "#8ab88a", fontSize: "13px" }}>
                  {batt_days === Infinity ? "∞" : `${fmt(batt_days / 365, 2)} yr`}
                </div>
              </div>
            </div>
            <div className="footnote" style={{ marginTop: "8px" }}>
              * TX-only estimate. Add idle/sleep current (RFM95W sleep ~0.2 µA, standby ~1.6 mA), MCU/RPi current, and sensor peripheral draw for full system model.
            </div>
          </div>

          {/* Summary Table */}
          <div className="card">
            <div className="label">Configuration Summary</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <tbody>
                {[
                  ["SF / BW / CR", `SF${sf} / ${bw} kHz / 4:${cr + 4}`],
                  ["Payload", `${payload} bytes`],
                  ["Preamble", `${preamble} symbols`],
                  ["Header / CRC", `${explicitHeader ? "Explicit" : "Implicit"} / ${crc ? "ON" : "OFF"}`],
                  ["Low DR Opt", ldrRequired ? `ON (auto — Tsym ${tSym_ms.toFixed(2)} ms)` : ldrManual ? "ON (manual)" : "OFF"],
                  ["TX Power", `+${txPower} dBm`],
                  ["Region", region === "eu" ? `EU 868 — ${euBandObj?.label}` : "US 915 (FHSS)"],
                ].map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: "1px solid #1a2e1c" }}>
                    <td style={{ padding: "5px 0", color: "#3a6a3a" }}>{k}</td>
                    <td style={{ padding: "5px 0", textAlign: "right", color: "#8ab88a" }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>
      </div>
    </div>
  );
}
