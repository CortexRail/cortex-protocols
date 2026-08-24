"use client";

import { useState } from "react";
import type { UsageBucket } from "@/types/marketplace";
import { formatPrice } from "@/lib/formatters";

// Sequential hue, single series — the chart's own title says what's plotted,
// so no legend box (see dataviz skill: "a single series needs no legend").
const SERIES_COLOR = "#3987e5"; // sequential blue, step 400 (dark-mode anchor)

function formatBucketLabel(ms: number, bucketSeconds: number): string {
  const date = new Date(ms);
  if (bucketSeconds >= 86_400) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Round a max value up to a clean tick step (1/2/5 x 10^n). */
function niceMax(value: number): number {
  if (value <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 5, 10];
  const step = steps.find((s) => value <= s * magnitude) ?? 10;
  return step * magnitude;
}

export default function CallsChart({ data, bucketSeconds }: { data: UsageBucket[]; bucketSeconds: number }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
        No calls recorded in this window yet.
      </div>
    );
  }

  const maxCalls = niceMax(Math.max(...data.map((d) => d.calls)));
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((maxCalls / tickCount) * i));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <h3 className="text-sm font-semibold text-zinc-300">Calls per {bucketSeconds >= 86_400 ? "day" : "hour"}</h3>

      <div className="mt-4 flex gap-3">
        {/* Y-axis ticks — recessive, hairline gridlines implied by position only */}
        <div className="flex h-48 flex-col justify-between text-right text-xs text-zinc-500 [font-variant-numeric:tabular-nums]">
          {[...ticks].reverse().map((tick) => (
            <div key={tick}>{tick.toLocaleString()}</div>
          ))}
        </div>

        <div className="relative flex h-48 flex-1 items-end gap-[2px] border-l border-b border-zinc-800">
          {data.map((bucket, index) => {
            const heightPct = maxCalls > 0 ? (bucket.calls / maxCalls) * 100 : 0;
            const isActive = activeIndex === index;
            return (
              <div key={bucket.bucketStart} className="relative flex h-full flex-1 items-end justify-center">
                {isActive && (
                  <div
                    role="tooltip"
                    className="absolute bottom-full z-10 mb-2 w-max max-w-[180px] -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs shadow-lg"
                    style={{ left: "50%" }}
                  >
                    <p className="font-semibold text-white">{bucket.calls.toLocaleString()} calls</p>
                    <p className="mt-0.5 text-zinc-400">{formatPrice(bucket.revenue)}</p>
                    <p className="mt-0.5 text-zinc-500">{formatBucketLabel(bucket.bucketStart, bucketSeconds)}</p>
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`${formatBucketLabel(bucket.bucketStart, bucketSeconds)}: ${bucket.calls} calls, ${formatPrice(bucket.revenue)}`}
                  className="w-full max-w-[24px] rounded-t transition-opacity hover:opacity-80 focus:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                  style={{
                    height: `${Math.max(heightPct, bucket.calls > 0 ? 2 : 0)}%`,
                    backgroundColor: SERIES_COLOR,
                    minHeight: bucket.calls > 0 ? "2px" : 0,
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex justify-between text-xs text-zinc-500">
        <span>{formatBucketLabel(data[0].bucketStart, bucketSeconds)}</span>
        {data.length > 1 && <span>{formatBucketLabel(data[data.length - 1].bucketStart, bucketSeconds)}</span>}
      </div>
    </div>
  );
}
