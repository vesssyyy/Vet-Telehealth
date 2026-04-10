/**
 * Vet dashboard — booking rate line chart (Chart.js on window).
 * Buckets new bookings by createdAt; X granularity follows selected period / range span.
 */

const DAY_MS = 86400000;

/**
 * Product of non-1 `zoom` values from `el` up to `<html>` (Chrome/Chromium mis-map canvas hits under CSS zoom).
 * @param {HTMLElement | null} el
 * @returns {number}
 */
function accumulatedCssZoom(el) {
    if (typeof document === 'undefined' || !el || !el.getRootNode) return 1;
    let z = 1;
    let node = el;
    const root = el.getRootNode();
    while (node && node.nodeType === 1 && node !== root) {
        const style = getComputedStyle(node);
        const raw = style.zoom;
        if (raw && raw !== 'normal') {
            const parsed = parseFloat(raw);
            if (Number.isFinite(parsed) && parsed > 0) z *= parsed;
        }
        node = node.parentElement;
    }
    return z;
}

// Chart.js: correct pointer x/y when ancestors use CSS `zoom` (e.g. root 0.75 desktop layout).
const chartCssZoomFixPlugin = {
    id: 'telehealthChartCssZoomFix',
    beforeEvent(chart, args) {
        const evt = args.event;
        if (!evt || evt.x == null || evt.y == null) return;
        const factor = accumulatedCssZoom(chart.canvas);
        if (factor === 1) return;
        evt.x /= factor;
        evt.y /= factor;
        args.inChartArea = chart.isPointInArea(evt);
    },
};

/**
 * @param {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} period
 * @param {number} customFromMs
 * @param {number} customToMs
 */
export function getPeriodRangeBounds(period, now = new Date(), customFromMs = 0, customToMs = 0) {
    const nowMs = now.getTime();
    if (period === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
        return { startMs: start, endMs: end };
    }
    if (period === '3d') return { startMs: nowMs - 3 * DAY_MS, endMs: nowMs };
    if (period === '7d') return { startMs: nowMs - 7 * DAY_MS, endMs: nowMs };
    if (period === '30d') return { startMs: nowMs - 30 * DAY_MS, endMs: nowMs };
    if (period === 'month') {
        const y = now.getFullYear();
        const m = now.getMonth();
        return {
            startMs: new Date(y, m, 1).getTime(),
            endMs: new Date(y, m + 1, 0, 23, 59, 59, 999).getTime(),
        };
    }
    if (period === 'custom') {
        if (Number.isFinite(customFromMs) && Number.isFinite(customToMs) && customFromMs > 0 && customToMs > 0) {
            return { startMs: customFromMs, endMs: customToMs };
        }
    }
    return { startMs: nowMs - 7 * DAY_MS, endMs: nowMs };
}

/**
 * @param {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} period
 * @param {number} startMs
 * @param {number} endMs
 * @returns {'hour' | 'day' | 'week' | 'month'}
 */
export function getGranularity(period, startMs, endMs) {
    const spanDays = Math.max(0, endMs - startMs) / DAY_MS;
    if (period === 'today') return 'hour';
    if (period === '3d' || period === '7d') return 'day';
    if (period === '30d') return 'day';
    if (period === 'month') return 'day';
    if (period === 'custom') {
        if (spanDays <= 1.001) return 'hour';
        if (spanDays <= 14) return 'day';
        if (spanDays <= 120) return 'week';
        return 'month';
    }
    return 'day';
}

function startOfLocalDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function startOfLocalWeekMonday(ms) {
    const d = new Date(startOfLocalDay(ms));
    const day = d.getDay();
    const diff = (day + 6) % 7;
    d.setDate(d.getDate() - diff);
    return d.getTime();
}

// @returns {{ bucketStarts: number[], labelForIndex: (i: number) => string, endForIndex: (i: number) => number }}
function buildBuckets(granularity, startMs, endMs) {
    if (granularity === 'hour') {
        const day = new Date(startMs);
        const y = day.getFullYear();
        const mo = day.getMonth();
        const da = day.getDate();
        const bucketStarts = [];
        for (let h = 0; h < 24; h++) {
            bucketStarts.push(new Date(y, mo, da, h, 0, 0, 0).getTime());
        }
        const labelForIndex = (i) =>
            new Date(bucketStarts[i]).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
            });
        const endForIndex = (i) => {
            if (i === bucketStarts.length - 1) return Math.min(endMs + 1, bucketStarts[i] + 3600000);
            return bucketStarts[i + 1];
        };
        return { bucketStarts, labelForIndex, endForIndex };
    }

    if (granularity === 'day') {
        const bucketStarts = [];
        const cur = new Date(startOfLocalDay(startMs));
        const last = startOfLocalDay(endMs);
        for (let t = cur.getTime(); t <= last; t += DAY_MS) {
            bucketStarts.push(t);
        }
        if (bucketStarts.length === 0) bucketStarts.push(startOfLocalDay(startMs));
        const labelForIndex = (i) =>
            new Date(bucketStarts[i]).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
            });
        const endForIndex = (i) => {
            if (i === bucketStarts.length - 1) return endMs + 1;
            return bucketStarts[i + 1];
        };
        return { bucketStarts, labelForIndex, endForIndex };
    }

    if (granularity === 'week') {
        const bucketStarts = [];
        let w = startOfLocalWeekMonday(startMs);
        for (;;) {
            if (w > endMs) break;
            const weekEnd = w + 7 * DAY_MS - 1;
            if (weekEnd >= startMs) bucketStarts.push(w);
            const d = new Date(w);
            d.setDate(d.getDate() + 7);
            w = d.getTime();
            if (bucketStarts.length > 520) break;
        }
        if (bucketStarts.length === 0) bucketStarts.push(startOfLocalWeekMonday(startMs));
        const labelForIndex = (i) => {
            const a = bucketStarts[i];
            const b = Math.min(a + 7 * DAY_MS - 1, endMs);
            const fa = new Date(a).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const fb = new Date(b).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            return fa === fb ? fa : `${fa} – ${fb}`;
        };
        const endForIndex = (i) => {
            const next = i + 1 < bucketStarts.length ? bucketStarts[i + 1] : bucketStarts[i] + 7 * DAY_MS;
            return Math.min(next, endMs + 1);
        };
        return { bucketStarts, labelForIndex, endForIndex };
    }

    // month
    const bucketStarts = [];
    const cur = new Date(startMs);
    cur.setDate(1);
    cur.setHours(0, 0, 0, 0);
    while (cur.getTime() <= endMs) {
        bucketStarts.push(cur.getTime());
        cur.setMonth(cur.getMonth() + 1);
        if (bucketStarts.length > 240) break;
    }
    if (bucketStarts.length === 0) {
        const d = new Date(startMs);
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        bucketStarts.push(d.getTime());
    }
    const labelForIndex = (i) =>
        new Date(bucketStarts[i]).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    const endForIndex = (i) => {
        if (i === bucketStarts.length - 1) return endMs + 1;
        return bucketStarts[i + 1];
    };
    return { bucketStarts, labelForIndex, endForIndex };
}

/**
 * @param {number[]} bookingTimesMs
 * @param {number} startMs
 * @param {number} endMs
 */
export function aggregateBookings(bookingTimesMs, startMs, endMs, granularity) {
    const { bucketStarts, labelForIndex, endForIndex } = buildBuckets(granularity, startMs, endMs);
    const counts = bucketStarts.map(() => 0);
    const inRange = bookingTimesMs.filter((t) => t >= startMs && t <= endMs);
    for (const t of inRange) {
        for (let i = 0; i < bucketStarts.length; i++) {
            const a = bucketStarts[i];
            const b = endForIndex(i);
            if (t >= a && t < b) {
                counts[i]++;
                break;
            }
        }
    }
    const labels = bucketStarts.map((_, i) => labelForIndex(i));
    const total = counts.reduce((s, n) => s + n, 0);
    const peak = counts.reduce((m, n) => Math.max(m, n), 0);
    return { labels, counts, bucketStarts, total, peak, granularity };
}

function readCssVar(el, name, fallback) {
    if (!el) return fallback;
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
}

/**
 * @param {HTMLElement} root — .dashboard-booking-rate-chart-inner
 * @param {object} opts
 * @param {() => 'count' | 'percent'} opts.getYMode
 */
export function createBookingRateChart(root, opts = {}) {
    const canvas = root.querySelector('canvas');
    const emptyEl = root.querySelector('.dashboard-booking-rate-empty');
    const getYMode = typeof opts.getYMode === 'function' ? opts.getYMode : () => 'count';

    if (typeof window.Chart === 'undefined') {
        console.warn('Chart.js not loaded');
        return { update: () => {}, destroy: () => {}, resize: () => {} };
    }

    const accent = readCssVar(root, '--accent-color', '#2c5f7d');
    const textMuted = readCssVar(root, '--text-light', '#6b7280');
    const textDark = readCssVar(root, '--text-dark', '#1a1a1a');
    const border = readCssVar(root, '--border-color', '#e5e7eb');
    const grid = readCssVar(root, '--border-color', '#e5e7eb');

    const fillRgb = '74, 144, 164';

    /** @type {{ destroy: () => void, data: object, options: object, update: (mode?: string) => void, resize: () => void } | null} */
    let chart = null;

    // Tooltip / axis context for latest dataset
    let latestMeta = {
        bucketStarts: [],
        granularity: 'day',
        total: 0,
        peak: 0,
        rangeEndMs: 0,
        counts: [],
    };

    function destroyChart() {
        if (chart) {
            chart.destroy();
            chart = null;
        }
    }

    function maxTicksForWidth() {
        const w = root.clientWidth || 400;
        if (w < 360) return 5;
        if (w < 520) return 7;
        if (w < 720) return 10;
        return 12;
    }

    // Monospace-friendly rows: label column + value column (no color swatch).
    const tooltipLabelColWidth = 20;
    function tooltipMetricRow(label, value) {
        return `${String(label).padEnd(tooltipLabelColWidth)} ${String(value)}`;
    }

    function buildOrUpdateChart(labels, counts, meta) {
        latestMeta = {
            bucketStarts: meta.bucketStarts,
            granularity: meta.granularity,
            total: meta.total,
            peak: meta.peak,
            rangeEndMs: meta.rangeEndMs,
            counts,
        };

        const mode = getYMode();
        const peak = meta.peak || 0;
        let displayValues = counts;
        let yAxisTitle = 'Bookings';
        if (mode === 'percent') {
            displayValues = peak > 0 ? counts.map((c) => (c / peak) * 100) : counts.map(() => 0);
            yAxisTitle = '% of peak';
        }

        const chartData = {
            labels,
            datasets: [
                {
                    label: mode === 'percent' ? 'Booking rate (% of peak)' : 'Bookings',
                    data: displayValues,
                    borderColor: accent,
                    backgroundColor: `rgba(${fillRgb}, 0.12)`,
                    fill: true,
                    tension: 0.28,
                    pointRadius: labels.length > 60 ? 0 : labels.length > 24 ? 2 : 3,
                    pointHoverRadius: 5,
                    borderWidth: 2,
                },
            ],
        };

        const tooltipCallbacks = {
            title(items) {
                const m = latestMeta;
                const i = items[0]?.dataIndex ?? 0;
                const start = m.bucketStarts[i];
                if (start == null) return '';
                if (m.granularity === 'hour') {
                    return new Date(start).toLocaleString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                    });
                }
                if (m.granularity === 'day') {
                    return new Date(start).toLocaleDateString(undefined, {
                        weekday: 'short',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                    });
                }
                if (m.granularity === 'week') {
                    const end = Math.min(start + 7 * DAY_MS - 1, m.rangeEndMs);
                    const a = new Date(start).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                    });
                    const b = new Date(end).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                    });
                    return a === b ? a : `${a} – ${b}`;
                }
                return new Date(start).toLocaleDateString(undefined, {
                    month: 'long',
                    year: 'numeric',
                });
            },
            label(ctx) {
                const m = latestMeta;
                const i = ctx.dataIndex;
                const c = m.counts[i] ?? 0;
                const share = m.total > 0 ? ((c / m.total) * 100).toFixed(1) : '0';
                const pk = m.peak || 0;
                if (mode === 'percent') {
                    const pct = pk > 0 ? `${((c / pk) * 100).toFixed(1)}%` : '0%';
                    return [
                        tooltipMetricRow('% of peak', pct),
                        tooltipMetricRow('Bookings', c),
                        tooltipMetricRow('Share of period', `${share}%`),
                    ];
                }
                const peakVal = pk > 0 ? `${((c / pk) * 100).toFixed(1)}%` : '—';
                return [
                    tooltipMetricRow('Bookings', c),
                    tooltipMetricRow('Share of period', `${share}%`),
                    tooltipMetricRow('% of peak', peakVal),
                ];
            },
        };

        const tooltipFontMono =
            "ui-monospace, 'Cascadia Code', 'Segoe UI Mono', Consolas, 'Liberation Mono', monospace";
        const tooltipFontTitle = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

        const options = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 280 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    displayColors: false,
                    titleAlign: 'left',
                    bodyAlign: 'left',
                    padding: { top: 10, right: 12, bottom: 10, left: 12 },
                    titleMarginBottom: 6,
                    bodySpacing: 4,
                    titleFont: { size: 12, weight: '600', family: tooltipFontTitle },
                    bodyFont: { size: 12, weight: '400', family: tooltipFontMono },
                    callbacks: tooltipCallbacks,
                },
            },
            scales: {
                x: {
                    grid: { color: `${grid}55`, drawTicks: true },
                    ticks: {
                        color: textMuted,
                        maxRotation: 40,
                        minRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: maxTicksForWidth(),
                        font: { size: 11 },
                    },
                    border: { color: border },
                },
                y: {
                    beginAtZero: true,
                    suggestedMax:
                        mode === 'percent'
                            ? 100
                            : undefined,
                    grid: { color: `${grid}44` },
                    ticks: {
                        color: textMuted,
                        precision: mode === 'percent' ? 0 : 0,
                        maxTicksLimit: 8,
                        callback(v) {
                            if (mode === 'percent') return `${Math.round(v)}%`;
                            return Number.isInteger(v) ? v : '';
                        },
                    },
                    border: { color: border },
                    title: {
                        display: true,
                        text: yAxisTitle,
                        color: textMuted,
                        font: { size: 11, weight: '600' },
                    },
                },
            },
        };

        if (!chart) {
            chart = new window.Chart(canvas, {
                type: 'line',
                data: chartData,
                options,
                plugins: [chartCssZoomFixPlugin],
            });
        } else {
            chart.data.labels = labels;
            chart.data.datasets[0].data = displayValues;
            chart.data.datasets[0].label = chartData.datasets[0].label;
            chart.data.datasets[0].pointRadius = chartData.datasets[0].pointRadius;
            const tt = chart.options.plugins.tooltip;
            tt.callbacks = tooltipCallbacks;
            tt.displayColors = false;
            tt.titleAlign = 'left';
            tt.bodyAlign = 'left';
            tt.padding = options.plugins.tooltip.padding;
            tt.titleMarginBottom = options.plugins.tooltip.titleMarginBottom;
            tt.bodySpacing = options.plugins.tooltip.bodySpacing;
            tt.titleFont = { ...options.plugins.tooltip.titleFont };
            tt.bodyFont = { ...options.plugins.tooltip.bodyFont };
            chart.options.scales.y.title.text = yAxisTitle;
            chart.options.scales.y.suggestedMax = mode === 'percent' ? 100 : undefined;
            chart.options.scales.y.ticks.callback = options.scales.y.ticks.callback;
            chart.options.scales.x.ticks.maxTicksLimit = maxTicksForWidth();
            chart.update('none');
        }
    }

    const resizeObserver =
        typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => {
                  chart?.resize();
              })
            : null;
    if (resizeObserver && root) resizeObserver.observe(root);

    return {
        /**
         * @param {number[]} bookingTimesMs
         * @param {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} period
         * @param {number} customFromMs
         * @param {number} customToMs
         */
        update(bookingTimesMs, period, customFromMs, customToMs) {
            const now = new Date();
            const { startMs, endMs } = getPeriodRangeBounds(period, now, customFromMs, customToMs);
            const g = getGranularity(period, startMs, endMs);
            const { labels, counts, bucketStarts, total, peak } = aggregateBookings(
                bookingTimesMs,
                startMs,
                endMs,
                g,
            );

            if (labels.length === 0) {
                destroyChart();
                if (emptyEl) emptyEl.classList.remove('is-hidden');
                if (canvas) canvas.classList.add('is-hidden');
                return;
            }

            if (emptyEl) emptyEl.classList.add('is-hidden');
            if (canvas) canvas.classList.remove('is-hidden');

            const meta = {
                bucketStarts,
                granularity: g,
                total,
                peak,
                rangeEndMs: endMs,
            };
            buildOrUpdateChart(labels, counts, meta);
        },

        destroy() {
            resizeObserver?.disconnect();
            destroyChart();
        },

        resize() {
            chart?.resize();
        },

        refreshTheme() {
            if (!chart) return;
            const a = readCssVar(root, '--accent-color', '#2c5f7d');
            const tm = readCssVar(root, '--text-light', '#6b7280');
            const td = readCssVar(root, '--text-dark', '#1a1a1a');
            const br = readCssVar(root, '--border-color', '#e5e7eb');
            chart.data.datasets[0].borderColor = a;
            if (chart.options.scales?.x?.ticks) chart.options.scales.x.ticks.color = tm;
            if (chart.options.scales?.y?.ticks) chart.options.scales.y.ticks.color = tm;
            if (chart.options.scales?.y?.title) chart.options.scales.y.title.color = tm;
            if (chart.options.scales?.x?.border) chart.options.scales.x.border.color = br;
            if (chart.options.scales?.y?.border) chart.options.scales.y.border.color = br;
            chart.update('none');
        },
    };
}
