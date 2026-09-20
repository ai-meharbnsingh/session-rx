/**
 * BP-001.30 — thin wrappers over the VENDORED Chart.js (DIS-001).
 *
 * The library is `public/vendor/chart.umd.min.js`, loaded by index.html as a
 * classic script, so it arrives as `globalThis.Chart`. There is no import of a
 * CDN module, no dynamic import of a URL, and no runtime network call anywhere
 * in this file. If the global is missing, every entry point says so in the page
 * instead of throwing — a silent empty box would look like "no data".
 *
 * THE INVARIANT THIS FILE EXISTS FOR
 * ---------------------------------
 * A NULL DATA POINT MUST BREAK THE LINE. `src/analyzer/trends.js` emits `null`
 * for a day it could not measure (R1: "a day with no data is not a zero"). Two
 * things are therefore non-negotiable here:
 *
 *   `spanGaps: false`  — otherwise Chart.js draws straight through the gap and
 *                        invents a trend across days nobody observed.
 *   genuine `null`s    — `?? 0` anywhere in this file would turn "we did not
 *                        measure Tuesday" into "Tuesday was zero", which is the
 *                        exact lie the whole product is built to avoid.
 *
 * `toNullable` is the only way a value enters a dataset, and it maps everything
 * non-finite — undefined, NaN, strings — to `null`, never to 0.
 */

const CHART_BY_CONTAINER = new WeakMap();

/** G3 zones, in percent: green > 95, yellow 85..95 inclusive, red < 85. */
export const CACHE_ZONES = Object.freeze({ green: 95, yellow: 85 });

const FALLBACK_COLORS = Object.freeze({
  text: "#edf2f7",
  muted: "#8d9aae",
  subtle: "#5f6c7e",
  border: "#273244",
  accent: "#68a7ff",
  accentStrong: "#9bc6ff",
  info: "#7fb8d4",
  zoneGreen: "#55d6a1",
  zoneYellow: "#f3bd64",
  zoneRed: "#f27c86",
  unknown: "#a3b0c4",
});

const CSS_VARS = Object.freeze({
  text: "--text",
  muted: "--muted",
  subtle: "--subtle",
  border: "--border",
  accent: "--accent",
  accentStrong: "--accent-strong",
  info: "--info",
  zoneGreen: "--zone-green",
  zoneYellow: "--zone-yellow",
  zoneRed: "--zone-red",
  unknown: "--unknown",
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const str = (value) => (typeof value === "string" ? value : "");

/** Read the theme from the stylesheet so the chart cannot drift from the page. */
function palette() {
  const colors = { ...FALLBACK_COLORS };
  try {
    const computed = globalThis.getComputedStyle?.(document.documentElement);
    if (computed) {
      for (const [key, variable] of Object.entries(CSS_VARS)) {
        const value = str(computed.getPropertyValue(variable)).trim();
        if (value) colors[key] = value;
      }
    }
  } catch {
    // A theme read must never be the reason a chart fails to draw.
  }
  return colors;
}

/**
 * The only path a number takes into a dataset.
 *
 * Anything that is not a finite number becomes `null` — an explicit gap. It
 * never becomes 0, because 0 is a measurement and this is the absence of one.
 */
export function toNullable(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Zone for a G3 hit rate, or null when there is no rate to place. */
function zoneOf(hitRate, zones) {
  if (toNullable(hitRate) === null) return null;
  if (hitRate > zones.green) return "green";
  if (hitRate >= zones.yellow) return "yellow";
  return "red";
}

function zoneColor(zone, colors) {
  if (zone === "green") return colors.zoneGreen;
  if (zone === "yellow") return colors.zoneYellow;
  if (zone === "red") return colors.zoneRed;
  return colors.unknown;
}

// ------------------------------------------------------------------ config

function axisConfig(colors, { stacked = false, title = "", percent = false } = {}) {
  return {
    x: {
      stacked,
      grid: { color: colors.border, drawTicks: false },
      ticks: { color: colors.subtle, maxRotation: 0, autoSkipPadding: 12 },
    },
    y: {
      stacked,
      beginAtZero: true,
      suggestedMax: percent ? 100 : undefined,
      title: title ? { display: true, text: title, color: colors.muted } : undefined,
      grid: { color: colors.border, drawTicks: false },
      ticks: { color: colors.subtle },
    },
  };
}

/**
 * Build the Chart.js config for one spec. Exported because this is where the
 * null-handling contract lives, and it is worth asserting without a browser.
 *
 * @param {{kind: "line"|"stacked-bar"|"zone-line", labels?: Array<string>,
 *          datasets?: Array<{label?: string, data?: Array<number|null>, color?: string,
 *                            fill?: boolean}>,
 *          yTitle?: string, percent?: boolean, zones?: {green: number, yellow: number}}} spec
 * @returns {object} a Chart.js configuration object
 */
export function buildChartConfig(spec = {}) {
  const colors = palette();
  const kind = str(spec.kind) || "line";
  const labels = Array.isArray(spec.labels) ? spec.labels.map((label) => String(label)) : [];
  const zones = { ...CACHE_ZONES, ...(spec.zones && typeof spec.zones === "object" ? spec.zones : {}) };
  const inputs = Array.isArray(spec.datasets) ? spec.datasets : [];
  const series = [colors.accent, colors.info, colors.accentStrong];

  const common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    // No remote anything, and no attempt to fetch a font: the canvas inherits
    // the page's own system stack.
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: inputs.length > 1, labels: { color: colors.muted, boxWidth: 10 } },
      tooltip: {
        callbacks: {
          // A null point must say so in the tooltip too, not read as 0.
          label(ctx) {
            const raw = toNullable(ctx.parsed?.y);
            const name = str(ctx.dataset?.label) || "value";
            if (raw === null) return `${name}: not measured`;
            return `${name}: ${raw.toLocaleString("en-US")}${spec.percent ? "%" : ""}`;
          },
        },
      },
    },
  };

  if (kind === "stacked-bar") {
    return {
      type: "bar",
      data: {
        labels,
        datasets: inputs.map((dataset, index) => ({
          label: str(dataset.label) || `series ${index + 1}`,
          data: (Array.isArray(dataset.data) ? dataset.data : []).map(toNullable),
          backgroundColor: str(dataset.color) || series[index % series.length],
          borderWidth: 0,
          // A stack with a null component is short by that component — it is
          // not silently completed with a zero.
          skipNull: true,
        })),
      },
      options: { ...common, scales: axisConfig(colors, { stacked: true, title: str(spec.yTitle) }) },
    };
  }

  if (kind === "zone-line") {
    const input = inputs[0] ?? {};
    const values = (Array.isArray(input.data) ? input.data : []).map(toNullable);
    return {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: str(input.label) || "cache hit rate",
          data: values,
          // BREAK the line at a gap. Never true.
          spanGaps: false,
          borderColor: colors.accent,
          borderWidth: 2,
          tension: 0,
          pointRadius: 3,
          pointBackgroundColor: values.map((value) => zoneColor(zoneOf(value, zones), colors)),
          pointBorderColor: values.map((value) => zoneColor(zoneOf(value, zones), colors)),
          segment: {
            // A segment is coloured by the zone it ENDS in; a segment touching a
            // null is not drawn at all, which is the point.
            borderColor(ctx) {
              const end = toNullable(ctx.p1?.parsed?.y);
              return zoneColor(zoneOf(end, zones), colors);
            },
          },
          fill: false,
        }],
      },
      options: { ...common, scales: axisConfig(colors, { title: str(spec.yTitle), percent: true }) },
    };
  }

  return {
    type: "line",
    data: {
      labels,
      datasets: inputs.map((dataset, index) => ({
        label: str(dataset.label) || `series ${index + 1}`,
        data: (Array.isArray(dataset.data) ? dataset.data : []).map(toNullable),
        // BREAK the line at a gap. Never true.
        spanGaps: false,
        borderColor: str(dataset.color) || series[index % series.length],
        backgroundColor: str(dataset.color) || series[index % series.length],
        borderWidth: 2,
        tension: 0,
        pointRadius: 2,
        fill: dataset.fill === true,
      })),
    },
    options: { ...common, scales: axisConfig(colors, { title: str(spec.yTitle), percent: spec.percent === true }) },
  };
}

// ----------------------------------------------------------------- render

const isCanvas = (node) => String(node?.tagName ?? "").toUpperCase() === "CANVAS";

/** A ready-made Chart.js configuration, as opposed to one of our own specs. */
function isChartConfig(value) {
  return Boolean(value) && typeof value === "object"
    && typeof value.type === "string" && Boolean(value.data) && typeof value.data === "object";
}

/**
 * Where an explanatory message can go. A caller that hands us a bare `<canvas>`
 * gets the message in the canvas's parent, because text cannot live in a canvas.
 */
function messageHost(target) {
  if (isCanvas(target)) {
    const parent = target.parentNode ?? target.parent ?? null;
    return parent && typeof parent.replaceChildren === "function" ? parent : null;
  }
  return typeof target?.replaceChildren === "function" ? target : null;
}

function unavailable(target, message) {
  const host = messageHost(target);
  if (host) host.replaceChildren(el("div", "chart-empty", message));
  return null;
}

const nullSafe = (value) => (value && typeof value === "object" ? value : toNullable(value));

/**
 * Harden a caller-supplied Chart.js config.
 *
 * This module is the single chokepoint for the product's null rule, so it holds
 * even for a config it did not build: `spanGaps` is forced to `false` on every
 * dataset, and every scalar data point goes through `toNullable`, so an
 * `undefined` or a `NaN` becomes an explicit gap rather than a silent 0. Point
 * OBJECTS (`{x, y}`) are passed through untouched. Nothing here can turn an
 * absent value into a number — only the other way round.
 */
function hardenConfig(config) {
  const datasets = Array.isArray(config?.data?.datasets) ? config.data.datasets : [];
  return {
    ...config,
    data: {
      ...config.data,
      datasets: datasets.map((dataset) => ({
        ...dataset,
        spanGaps: false,
        data: Array.isArray(dataset?.data) ? dataset.data.map(nullSafe) : dataset?.data,
      })),
    },
  };
}

function hasMeasurement(config) {
  const datasets = Array.isArray(config?.data?.datasets) ? config.data.datasets : [];
  return datasets.some((dataset) => (Array.isArray(dataset?.data) ? dataset.data : [])
    .some((value) => (value && typeof value === "object") || toNullable(value) !== null));
}

/**
 * Draw one chart.
 *
 * Two call shapes are supported, because both are in use across the frontend:
 *
 *   renderChart(container, {kind, labels, datasets})  // this module builds the config
 *   renderChart(canvasEl, chartJsConfig)             // the caller built it
 *
 * Either way the config passes through `hardenConfig`, so `spanGaps: false` and
 * genuine nulls are guaranteed at this boundary rather than trusted upstream.
 *
 * @param {Element} target a container to draw into, or a `<canvas>` to draw on
 * @param {object} spec `buildChartConfig`'s spec, or a Chart.js config
 * @param {{ChartCtor?: Function, height?: number, emptyMessage?: string}} [options]
 *   `ChartCtor` defaults to the vendored `globalThis.Chart`; it is a parameter
 *   only so a harness can inject a double.
 * @returns {object|null} the Chart instance, or null when nothing was drawn
 */
export function renderChart(target, spec = {}, options = {}) {
  if (!target || typeof target !== "object") return null;
  destroyChart(target);

  const Ctor = typeof options.ChartCtor === "function" ? options.ChartCtor : globalThis.Chart;
  if (typeof Ctor !== "function") {
    return unavailable(
      target,
      "The bundled chart library did not load, so no chart is drawn. "
      + "An empty chart area would look like an absence of data; this is an absence of the library.",
    );
  }

  const config = hardenConfig(isChartConfig(spec) ? spec : buildChartConfig(spec));
  if (!hasMeasurement(config)) {
    return unavailable(
      target,
      str(options.emptyMessage)
        || "No day in this window produced a measurement for this series, so there is "
        + "nothing to plot. This is not a run of zeros.",
    );
  }

  let canvas = target;
  if (!isCanvas(target)) {
    const wrap = el("div", "chart-canvas-wrap");
    if (typeof options.height === "number" && Number.isFinite(options.height)) {
      wrap.style.setProperty("height", `${options.height}px`);
    }
    canvas = document.createElement("canvas");
    if (str(spec.ariaLabel)) {
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", spec.ariaLabel);
    }
    wrap.append(canvas);
    target.replaceChildren(wrap);
  }

  const chart = new Ctor(canvas, config);
  CHART_BY_CONTAINER.set(target, chart);
  return chart;
}

/**
 * Destroy the chart attached to `target` (or the instance itself), releasing the
 * canvas so a re-render cannot leak a second Chart onto the same node. The key
 * is whatever was passed to `renderChart` — a container or a canvas.
 *
 * @param {Element|object} target a container or canvas previously passed to
 *   `renderChart`, or a Chart instance
 * @returns {boolean} true when something was destroyed
 */
export function destroyChart(target) {
  if (!target) return false;
  const chart = CHART_BY_CONTAINER.get(target) ?? (typeof target.destroy === "function" ? target : null);
  if (!chart) return false;
  try {
    chart.destroy();
  } catch {
    // A failed teardown must not block the next render.
  }
  if (CHART_BY_CONTAINER.has(target)) CHART_BY_CONTAINER.delete(target);
  return true;
}

export default renderChart;
