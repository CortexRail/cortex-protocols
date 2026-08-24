import React from "react";

interface AnalyticsData {
  totalRevenue: number;
  purchaseCount: number;
  uniqueBuyerCount: number;
  revenueOverTime: { date: string; revenue: number }[];
}

export default function AnalyticsChart({ data }: { data: AnalyticsData }) {
  if (!data) return null;

  const maxRevenue = Math.max(...data.revenueOverTime.map((d) => d.revenue), 100);

  return (
    <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg mt-8">
      <h3 className="font-semibold mb-4 text-xl">Owner Analytics</h3>
      
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="p-4 bg-black border border-zinc-800 rounded-lg">
          <p className="text-xs text-zinc-500 mb-2">Total Revenue</p>
          <p className="text-xl font-bold">{(data.totalRevenue / 10_000_000).toLocaleString()} XLM</p>
        </div>
        <div className="p-4 bg-black border border-zinc-800 rounded-lg">
          <p className="text-xs text-zinc-500 mb-2">Total Purchases</p>
          <p className="text-xl font-bold">{data.purchaseCount}</p>
        </div>
        <div className="p-4 bg-black border border-zinc-800 rounded-lg">
          <p className="text-xs text-zinc-500 mb-2">Unique Buyers</p>
          <p className="text-xl font-bold">{data.uniqueBuyerCount}</p>
        </div>
      </div>

      <h4 className="font-semibold mb-4 text-sm text-zinc-400">Revenue Over Time (Daily)</h4>
      {data.revenueOverTime.length === 0 ? (
        <p className="text-sm text-zinc-500">No revenue data yet.</p>
      ) : (
        <div className="h-48 flex items-end gap-2 border-b border-l border-zinc-800 pb-2 pl-2">
          {data.revenueOverTime.map((day, i) => {
            const heightPct = Math.max((day.revenue / maxRevenue) * 100, 2);
            return (
              <div key={i} className="flex flex-col items-center flex-1 group relative">
                <div 
                  className="w-full bg-purple-500 rounded-t-sm transition-all hover:bg-purple-400"
                  style={{ height: `${heightPct}%` }}
                />
                {/* Tooltip */}
                <div className="absolute bottom-full mb-2 hidden group-hover:block bg-black text-xs p-2 rounded border border-zinc-800 z-10 whitespace-nowrap">
                  {day.date}: {(day.revenue / 10_000_000).toLocaleString()} XLM
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
