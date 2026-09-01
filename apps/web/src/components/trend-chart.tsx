'use client';

/**
 * A small bar chart, drawn as SVG.
 *
 * No charting library. Recharts and its peers bring a dependency tree measured
 * in megabytes to a PWA whose whole proposition is working on a cheap phone over
 * a slow connection — and what is needed here is six bars and a baseline, which
 * is the code below.
 *
 * The other reason is control. A chart of a metric with a THRESHOLD has to draw
 * the threshold, and has to make crossing it obvious at a glance; that is the
 * entire point of plotting the flagged ratio rather than printing it. Getting a
 * general-purpose library to do exactly that is usually more work than this.
 */

export interface TrendPoint {
  label: string;
  /** `null` renders as a gap, not as zero. See below. */
  value: number | null;
}

export interface TrendChartProps {
  points: TrendPoint[];
  /** Formats a value for the tooltip and the axis. */
  format: (value: number) => string;
  /** Drawn as a dashed line, when the metric has a level that means something. */
  threshold?: number;
  thresholdLabel?: string;
  /** Bars at or above the threshold are drawn in the warning colour. */
  invertThreshold?: boolean;
}

const HEIGHT = 120;
const BAR_GAP = 6;

export function TrendChart({
  points,
  format,
  threshold,
  thresholdLabel,
  invertThreshold = false,
}: TrendChartProps): React.ReactElement {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);

  /**
   * The scale includes the threshold even when no bar reaches it.
   *
   * Without that, a month at 2% against a 12% threshold would fill the chart and
   * look alarming, because the tallest bar always fills the space. The threshold
   * is the thing that gives these numbers meaning, so it has to be on the axis
   * whether or not anything got near it.
   */
  const max = Math.max(...values, threshold ?? 0, 0.0001);

  const width = Math.max(points.length, 1) * 48;
  const barWidth = Math.max(48 - BAR_GAP, 4);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT + 22}`}
        className="h-40 w-full"
        role="img"
        aria-label={
          `Grafik ${points.length} bulan terakhir. ` +
          points.map((p) => `${p.label}: ${p.value === null ? 'tidak ada data' : format(p.value)}`).join('; ')
        }
      >
        {threshold !== undefined && (
          <>
            <line
              x1={0}
              x2={width}
              y1={HEIGHT - (threshold / max) * HEIGHT}
              y2={HEIGHT - (threshold / max) * HEIGHT}
              className="stroke-amber-500"
              strokeDasharray="4 3"
              strokeWidth={1}
            />
            {thresholdLabel && (
              <text
                x={2}
                y={Math.max(9, HEIGHT - (threshold / max) * HEIGHT - 3)}
                className="fill-amber-600 text-[9px]"
              >
                {thresholdLabel}
              </text>
            )}
          </>
        )}

        {points.map((point, index) => {
          const x = index * 48 + BAR_GAP / 2;

          /**
           * A month with no data renders as a hollow outline, never as a zero
           * bar. Zero is a measurement — "nothing was flagged" — and an absent
           * month is not one. Drawing them the same way is how a gap in the data
           * becomes a claim about the business.
           */
          if (point.value === null) {
            return (
              <g key={point.label}>
                <rect
                  x={x}
                  y={HEIGHT - 6}
                  width={barWidth}
                  height={6}
                  className="fill-none stroke-slate-300 dark:stroke-slate-600"
                  strokeDasharray="2 2"
                />
                <title>{`${point.label}: tidak ada data`}</title>
              </g>
            );
          }

          const height = Math.max((point.value / max) * HEIGHT, point.value > 0 ? 2 : 0);
          const over = threshold !== undefined && point.value >= threshold;
          const warn = invertThreshold ? !over : over;

          return (
            <g key={point.label}>
              <rect
                x={x}
                y={HEIGHT - height}
                width={barWidth}
                height={height}
                className={
                  warn
                    ? 'fill-amber-500 dark:fill-amber-400'
                    : 'fill-slate-400 dark:fill-slate-500'
                }
              />
              <title>{`${point.label}: ${format(point.value)}`}</title>
            </g>
          );
        })}

        {points.map((point, index) => (
          <text
            key={`label-${point.label}`}
            x={index * 48 + 24}
            y={HEIGHT + 14}
            textAnchor="middle"
            className="fill-slate-500 text-[9px]"
          >
            {point.label.slice(5)}
          </text>
        ))}
      </svg>
    </figure>
  );
}
