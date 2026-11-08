// =====================================================================
//  GACS dashboard
//  Leest read-only uit Supabase met de anon key. Geen build step nodig:
//  dit bestand is een ES module die de browser rechtstreeks uitvoert.
// =====================================================================

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";

const cfg = window.GACS_CONFIG ?? {};

if (!cfg.supabaseUrl || cfg.supabaseUrl.includes("JOUW-PROJECT-REF")) {
  showError(
    "config.js is nog niet ingevuld.\n" +
      "Zet supabaseUrl en supabaseAnonKey op de waarden uit " +
      "Supabase Studio → Project Settings → API.",
  );
  setStatus("error", "niet geconfigureerd");
  throw new Error("config ontbreekt");
}

const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------
//  Metadata per metric: hoe tonen we 'm, en wanneer is een waarde slecht?
//  Onbekende metrics krijgen automatisch een nette fallback.
// ---------------------------------------------------------------------
const METRICS = {
  co2:             { label: "CO₂",            unit: "ppm",  dec: 0, bands: [800, 1200] },
  temperature:     { label: "Temperatuur",    unit: "°C",   dec: 1, bands: null, comfort: [19, 25] },
  humidity:        { label: "Luchtvochtigheid", unit: "%",  dec: 0, bands: null, comfort: [30, 60] },
  light:           { label: "Licht",          unit: "lux",  dec: 0 },
  motion:          { label: "Beweging",       unit: "×",    dec: 0 },
  occupancy:       { label: "Bezetting",      unit: "",     dec: 0 },
  vdd:             { label: "Batterijspanning", unit: "mV", dec: 0 },
  pressure:        { label: "Luchtdruk",      unit: "hPa",  dec: 0 },
  "net.rssi":      { label: "RSSI",           unit: "dBm",  dec: 0 },
  "net.snr":       { label: "SNR",            unit: "dB",   dec: 1 },
  "net.sf":        { label: "Spreading factor", unit: "",   dec: 0 },
  "net.gateways":  { label: "Gateways",       unit: "",     dec: 0 },
  "net.battery_pct": { label: "Accu",         unit: "%",    dec: 0 },
};

function meta(metric) {
  return (
    METRICS[metric] ?? {
      label: metric.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      unit: "",
      dec: 1,
    }
  );
}

const SERIES_COLORS = [
  "#5ac8fa", "#f0a63c", "#4ec98f", "#c792ea", "#f0614e", "#8fa6c4",
];

// ---------------------------------------------------------------------
//  Toestand
// ---------------------------------------------------------------------
const state = {
  devices: [],          // uit device_status
  latest: new Map(),    // "device|metric" -> { value, measured_at }
  metrics: [],          // beschikbare metric-namen
  metric: cfg.defaultMetric ?? "co2",
  hours: 24,
  hidden: new Set(),    // device_ids die in de legenda zijn uitgezet
  chart: null,
};

const $ = (sel) => document.querySelector(sel);

const fmtTime = new Intl.DateTimeFormat("nl-NL", {
  hour: "2-digit", minute: "2-digit",
});
const fmtDateTime = new Intl.DateTimeFormat("nl-NL", {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});

function setStatus(stateName, text) {
  const el = $("#connection-status");
  el.dataset.state = stateName;
  el.querySelector(".status-text").textContent = text;
}

function showError(msg) {
  const slot = $("#error-slot");
  slot.textContent = msg;
  slot.hidden = false;
}

function clearError() {
  $("#error-slot").hidden = true;
}

/** Relatieve tijd, kort: "3 min", "2 u", "5 d". */
function ago(iso) {
  if (!iso) return "—";
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1) return "nu";
  if (mins < 60) return `${Math.round(mins)} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} u`;
  return `${Math.round(mins / 1440)} d`;
}

function fmtValue(metric, value) {
  if (value === null || value === undefined) return "—";
  const m = meta(metric);
  return value.toFixed(m.dec);
}

/** Kleurklasse op basis van drempelwaarden (CO₂) of comfortzone. */
function valueClass(metric, value) {
  const m = meta(metric);
  if (value === null || value === undefined) return "";
  if (m.bands) {
    if (value < m.bands[0]) return "v-good";
    if (value < m.bands[1]) return "v-warn";
    return "v-bad";
  }
  if (m.comfort) {
    return value >= m.comfort[0] && value <= m.comfort[1] ? "v-good" : "v-warn";
  }
  return "";
}

// ---------------------------------------------------------------------
//  Data ophalen
// ---------------------------------------------------------------------

async function loadDevices() {
  const { data, error } = await sb
    .from("device_status")
    .select("*")
    .order("display_name");
  if (error) throw error;
  state.devices = data ?? [];
}

async function loadLatest() {
  const { data, error } = await sb
    .from("latest_readings")
    .select("device_id, metric, value, measured_at");
  if (error) throw error;

  state.latest.clear();
  for (const row of data ?? []) {
    state.latest.set(`${row.device_id}|${row.metric}`, row);
  }
}

async function loadAvailableMetrics() {
  const { data, error } = await sb
    .from("device_metrics")
    .select("metric")
    .order("metric");
  if (error) throw error;

  const seen = new Set((data ?? []).map((r) => r.metric));
  // Sensormetrics eerst, netwerkmetrics achteraan.
  state.metrics = [...seen].sort((a, b) => {
    const na = a.startsWith("net.") ? 1 : 0;
    const nb = b.startsWith("net.") ? 1 : 0;
    return na - nb || meta(a).label.localeCompare(meta(b).label, "nl");
  });

  if (!state.metrics.includes(state.metric) && state.metrics.length) {
    state.metric = state.metrics[0];
  }
}

/** Bucketgrootte zo kiezen dat een grafiek nooit duizenden punten krijgt. */
function bucketMinutes(hours) {
  if (hours <= 6) return 5;
  if (hours <= 24) return 15;
  if (hours <= 168) return 60;
  return 240;
}

async function loadSeries() {
  const bucket = bucketMinutes(state.hours);
  const from = new Date(Date.now() - state.hours * 3600 * 1000).toISOString();

  const { data, error } = await sb.rpc("readings_binned", {
    p_devices: null,
    p_metric: state.metric,
    p_from: from,
    p_to: new Date().toISOString(),
    p_bucket_minutes: bucket,
  });
  if (error) throw error;

  const byDevice = new Map();
  for (const row of data ?? []) {
    if (!byDevice.has(row.device_id)) byDevice.set(row.device_id, []);
    byDevice.get(row.device_id).push({
      x: new Date(row.bucket),
      y: row.avg_value,
    });
  }
  return { byDevice, bucket };
}

// ---------------------------------------------------------------------
//  Renderen
// ---------------------------------------------------------------------

function deviceLabel(deviceId) {
  const d = state.devices.find((x) => x.device_id === deviceId);
  return d?.display_name ?? deviceId;
}

function renderDevices() {
  const grid = $("#device-grid");

  if (!state.devices.length) {
    grid.innerHTML =
      '<p class="placeholder">Nog geen sensoren in de database. ' +
      "Draai de backfill of wacht op de eerste uplink via de webhook.</p>";
    return;
  }

  const wanted = cfg.tileMetrics ?? ["co2", "temperature", "humidity"];

  grid.innerHTML = state.devices
    .map((d) => {
      const rows = wanted
        .map((metric) => {
          const r = state.latest.get(`${d.device_id}|${metric}`);
          if (!r) return "";
          const m = meta(metric);
          return `
            <div class="metric-row">
              <span class="metric-label">${esc(m.label)}</span>
              <span class="metric-value ${valueClass(metric, r.value)}">${
                fmtValue(metric, r.value)
              }<span class="unit">${esc(m.unit)}</span></span>
            </div>`;
        })
        .join("");

      const battery = state.latest.get(`${d.device_id}|net.battery_pct`);
      const metaBits = [d.room, d.model, battery ? `accu ${battery.value}%` : null]
        .filter(Boolean)
        .join(" · ");

      return `
        <article class="device-card ${d.online ? "" : "is-stale"}">
          <div class="device-card-head">
            <div>
              <div class="device-name">${esc(d.display_name)}</div>
              <div class="device-meta">${esc(metaBits || d.device_id)}</div>
            </div>
            <span class="pill ${d.online ? "pill-online" : "pill-offline"}">
              ${d.online ? ago(d.last_seen) : "offline"}
            </span>
          </div>
          <div class="metric-rows">
            ${rows || '<p class="placeholder">Geen van de gekozen metrics.</p>'}
          </div>
        </article>`;
    })
    .join("");
}

function renderMetricChips() {
  const box = $("#metric-chips");
  box.innerHTML = state.metrics
    .map(
      (m) =>
        `<button type="button" class="chip ${
          m === state.metric ? "is-active" : ""
        }" data-metric="${esc(m)}">${esc(meta(m).label)}</button>`,
    )
    .join("");
}

function renderHealth() {
  const body = $("#health-body");

  if (!state.devices.length) {
    body.innerHTML = '<tr><td colspan="9" class="placeholder">Geen data.</td></tr>';
    return;
  }

  const cell = (deviceId, metric) => {
    const r = state.latest.get(`${deviceId}|${metric}`);
    return r ? fmtValue(metric, r.value) : "—";
  };

  body.innerHTML = state.devices
    .map(
      (d) => `
      <tr>
        <td>${esc(d.display_name)}</td>
        <td>${esc(d.room ?? "—")}</td>
        <td>${esc([d.brand, d.model].filter(Boolean).join(" ") || "—")}</td>
        <td class="num">${cell(d.device_id, "net.rssi")}</td>
        <td class="num">${cell(d.device_id, "net.snr")}</td>
        <td class="num">${cell(d.device_id, "net.sf")}</td>
        <td class="num">${cell(d.device_id, "net.battery_pct")}</td>
        <td class="num">${d.readings_24h ?? 0}</td>
        <td>${d.last_seen ? esc(fmtDateTime.format(new Date(d.last_seen))) : "—"}</td>
      </tr>`,
    )
    .join("");
}

function renderLegend() {
  const box = $("#legend");
  const sets = state.chart?.data?.datasets ?? [];

  box.innerHTML = sets
    .map((ds) => {
      const swatch = `<span class="legend-swatch" style="background:${ds.borderColor}"></span>`;
      // Drempellijnen zijn vaste referenties, geen sensor: niet klikbaar.
      if (ds.deviceId?.startsWith("__threshold")) {
        return `<span class="legend-item is-static">${swatch}${esc(ds.label)}</span>`;
      }
      return `
        <button type="button" class="legend-item ${
          state.hidden.has(ds.deviceId) ? "is-off" : ""
        }" data-device="${esc(ds.deviceId)}">
          ${swatch}${esc(ds.label)}
        </button>`;
    })
    .join("");
}

async function renderChart() {
  const placeholder = $("#chart-placeholder");
  const { byDevice, bucket } = await loadSeries();

  const datasets = [...byDevice.entries()].map(([deviceId, points], i) => ({
    deviceId,
    label: deviceLabel(deviceId),
    data: points,
    borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
    backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.25,
    spanGaps: true,
    hidden: state.hidden.has(deviceId),
  }));

  placeholder.hidden = datasets.length > 0;
  if (!datasets.length) {
    placeholder.textContent = "Geen metingen in dit bereik.";
  }

  const m = meta(state.metric);
  const unitLabel = m.unit ? `${m.label} (${m.unit})` : m.label;
  const seriesCount = datasets.length; // vóór de drempellijnen erbij komen

  if (state.chart) {
    state.chart.data.datasets = datasets;
    state.chart.options.scales.y.title.text = unitLabel;
    state.chart.update();
  } else {
    state.chart = new Chart($("#chart"), {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#19222d",
            borderColor: "#22303f",
            borderWidth: 1,
            titleColor: "#e8eef5",
            bodyColor: "#93a4b6",
            padding: 10,
            callbacks: {
              label: (ctx) =>
                `${ctx.dataset.label}: ${fmtValue(state.metric, ctx.parsed.y)} ${
                  meta(state.metric).unit
                }`,
            },
          },
        },
        scales: {
          x: {
            type: "time",
            adapters: { date: { locale: "nl" } },
            time: {
              tooltipFormat: "dd LLL HH:mm",
              displayFormats: {
                minute: "HH:mm",
                hour: "HH:mm",
                day: "dd LLL",
                week: "dd LLL",
              },
            },
            grid: { color: "rgba(34,48,63,.55)" },
            ticks: { color: "#637386", maxRotation: 0, autoSkipPadding: 20 },
          },
          y: {
            title: { display: true, text: unitLabel, color: "#637386" },
            grid: { color: "rgba(34,48,63,.55)" },
            ticks: { color: "#637386" },
          },
        },
      },
    });
  }

  // Chart.js annotation-plugin zit niet in de UMD-build; drempels tekenen
  // we daarom als extra, niet-interactieve datasets over de volle breedte.
  if (m.bands?.length && datasets.length) {
    const xs = datasets.flatMap((d) => d.data.map((p) => p.x));
    const xMin = new Date(Math.min(...xs));
    const xMax = new Date(Math.max(...xs));
    for (const [i, v] of (m.bands ?? []).entries()) {
      state.chart.data.datasets.push({
        deviceId: `__threshold_${i}`,
        label: `grens ${v} ${m.unit}`,
        data: [{ x: xMin, y: v }, { x: xMax, y: v }],
        borderColor: i === 0 ? "rgba(240,180,41,.5)" : "rgba(240,97,78,.5)",
        borderWidth: 1,
        borderDash: [5, 4],
        pointRadius: 0,
        fill: false,
      });
    }
    state.chart.update();
  }

  $("#chart-note").textContent = seriesCount
    ? `Gemiddelde per ${bucket} min · ${seriesCount} sensor(en) · laatste ${
        state.hours >= 48 ? `${Math.round(state.hours / 24)} dagen` : `${state.hours} uur`
      }`
    : "";

  renderLegend();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ---------------------------------------------------------------------
//  Events
// ---------------------------------------------------------------------

$("#metric-chips").addEventListener("click", async (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  state.metric = btn.dataset.metric;
  renderMetricChips();
  await safely(renderChart);
});

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.hours = Number(btn.dataset.hours);
    await safely(renderChart);
  });
});

$("#legend").addEventListener("click", (e) => {
  const btn = e.target.closest(".legend-item");
  if (!btn) return;
  const id = btn.dataset.device;
  if (state.hidden.has(id)) state.hidden.delete(id);
  else state.hidden.add(id);

  for (const ds of state.chart.data.datasets) {
    if (ds.deviceId === id) ds.hidden = state.hidden.has(id);
  }
  state.chart.update();
  renderLegend();
});

// ---------------------------------------------------------------------
//  Opstarten + live bijwerken
// ---------------------------------------------------------------------

async function safely(fn) {
  try {
    await fn();
    clearError();
    return true;
  } catch (err) {
    console.error(err);
    showError(`${err.message ?? err}`);
    setStatus("error", "fout");
    return false;
  }
}

async function refreshAll() {
  await Promise.all([loadDevices(), loadLatest(), loadAvailableMetrics()]);
  renderDevices();
  renderMetricChips();
  renderHealth();
  await renderChart();
  $("#last-update").textContent = `bijgewerkt ${fmtTime.format(new Date())}`;
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => safely(refreshAll), 2500);
}

async function main() {
  setStatus("connecting", "verbinden…");

  const ok = await safely(refreshAll);
  if (!ok) return;

  setStatus("live", "live");

  // Realtime: elke nieuwe meting triggert een (gedebouncete) refresh.
  sb.channel("readings-live")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "readings" },
      scheduleRefresh,
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setStatus("live", "live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setStatus("connecting", "polling");
      }
    });

  // Vangnet voor als realtime uitvalt: elke 2 minuten alsnog verversen.
  setInterval(() => safely(refreshAll), 120000);
}

main();
