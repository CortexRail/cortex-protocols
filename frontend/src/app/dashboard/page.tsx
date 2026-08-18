"use client";

import { useState, useCallback, useEffect } from "react";
import { isConnected, getAddress } from "@stellar/freighter-api";

const API = "http://localhost:4000";

interface Asset {
  id: number;
  name: string;
  owner: string;
  description: string;
  assetType: string;
  licenseType: string;
  price: number;
  usageCount: number;
  isActive: boolean;
  createdAt: number;
}

interface License {
  id: number;
  assetId: number;
  buyer: string;
  licenseType: string;
  pricePaid: number;
  callsRemaining: number | null;
  expiresAt: number | null;
  isActive: boolean;
  purchasedAt: number;
}

interface RevenueEntry {
  assetId: number;
  assetName: string;
  assetType: string;
  currentPrice: number;
  licenseCount: number;
  totalRevenue: number;
}

interface Stream {
  id: number;
  sender: string;
  recipient: string;
  token: string;
  deposit: number;
  ratePerSecond: number;
  startTime: number;
  endTime: number;
  status: string;
  withdrawn: number;
}

interface ListResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; pages: number };
}

type Tab = "assets" | "licenses" | "streams";

export default function DashboardPage() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("assets");
  const [loading, setLoading] = useState(false);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [revenue, setRevenue] = useState<RevenueEntry[]>([]);
  const [streamsOut, setStreamsOut] = useState<Stream[]>([]);
  const [streamsIn, setStreamsIn] = useState<Stream[]>([]);

  const [delistingId, setDelistingId] = useState<number | null>(null);
  const [editingPriceId, setEditingPriceId] = useState<number | null>(null);
  const [newPrice, setNewPrice] = useState("");
  const [updatingPriceId, setUpdatingPriceId] = useState<number | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);

  const fetchDashboardData = useCallback(async (pk: string) => {
    setLoading(true);
    try {
      const [assetsRes, licensesRes, revenueRes, streamsOutRes, streamsInRes] =
        await Promise.all([
          fetch(`${API}/api/v1/assets?owner=${pk}&limit=100`),
          fetch(`${API}/api/v1/licenses?buyer=${pk}&limit=100`),
          fetch(`${API}/api/v1/analytics/revenue?owner=${pk}`),
          fetch(`${API}/api/v1/streams?sender=${pk}&status=Active&limit=100`),
          fetch(`${API}/api/v1/streams?recipient=${pk}&status=Active&limit=100`),
        ]);

      if (assetsRes.ok) {
        const d: ListResponse<Asset> = await assetsRes.json();
        setAssets(d.data || []);
      }
      if (licensesRes.ok) {
        const d: ListResponse<License> = await licensesRes.json();
        setLicenses(d.data || []);
      }
      if (revenueRes.ok) {
        const d = await revenueRes.json();
        setRevenue(d.data || []);
      }
      if (streamsOutRes.ok) {
        const d: ListResponse<Stream> = await streamsOutRes.json();
        setStreamsOut(d.data || []);
      }
      if (streamsInRes.ok) {
        const d: ListResponse<Stream> = await streamsInRes.json();
        setStreamsIn(d.data || []);
      }
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  async function connectWallet() {
    setConnecting(true);
    try {
      const connected = await isConnected();
      if (connected) {
        const { address } = await getAddress();
        setPublicKey(address);
        await fetchDashboardData(address);
      } else {
        alert("Freighter wallet not found. Please install the Freighter browser extension.");
      }
    } catch (err) {
      console.error("Wallet connection failed:", err);
      alert("Failed to connect wallet. Is Freighter installed?");
    } finally {
      setConnecting(false);
    }
  }

  function disconnectWallet() {
    setPublicKey(null);
    setAssets([]);
    setLicenses([]);
    setRevenue([]);
    setStreamsOut([]);
    setStreamsIn([]);
  }

  async function handleDelist(assetId: number) {
    if (!publicKey) return;
    setDelistingId(assetId);
    try {
      const res = await fetch(`${API}/api/v1/assets/${assetId}/delist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: publicKey }),
      });
      if (res.ok) {
        setAssets((prev) => prev.filter((a) => a.id !== assetId));
      }
    } catch (err) {
      console.error("Failed to delist asset:", err);
    } finally {
      setDelistingId(null);
    }
  }

  async function handleUpdatePrice(assetId: number) {
    if (!publicKey || !newPrice) return;
    const price = parseInt(newPrice, 10);
    if (isNaN(price) || price < 0) return;
    setUpdatingPriceId(assetId);
    try {
      const res = await fetch(`${API}/api/v1/assets/${assetId}/price`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: publicKey, price }),
      });
      if (res.ok) {
        setAssets((prev) =>
          prev.map((a) => (a.id === assetId ? { ...a, price } : a))
        );
        setEditingPriceId(null);
        setNewPrice("");
      }
    } catch (err) {
      console.error("Failed to update price:", err);
    } finally {
      setUpdatingPriceId(null);
    }
  }

  async function handleWithdraw(streamId: number, amount: number) {
    if (!publicKey) return;
    setWithdrawingId(streamId);
    try {
      const res = await fetch(`${API}/api/v1/streams/${streamId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: publicKey, amount }),
      });
      if (res.ok) {
        const updated: Stream = await res.json();
        setStreamsIn((prev) =>
          prev.map((s) => (s.id === streamId ? updated : s))
        );
      }
    } catch (err) {
      console.error("Failed to withdraw:", err);
    } finally {
      setWithdrawingId(null);
    }
  }

  function formatXLM(microUnits: number) {
    return (microUnits / 10_000_000).toFixed(4);
  }

  function formatTimestamp(ts: number) {
    return new Date(ts).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function shortenKey(key: string) {
    return `${key.slice(0, 12)}...${key.slice(-6)}`;
  }

  const totalRevenue = revenue.reduce((sum, r) => sum + r.totalRevenue, 0);
  const totalStreams = streamsOut.length + streamsIn.length;

  if (!publicKey) {
    return (
      <main className="min-h-screen bg-black text-white pt-12 px-6">
        <div className="max-w-4xl mx-auto text-center py-24">
          <p className="text-sm font-mono text-purple-400 tracking-widest uppercase mb-4">
            Dashboard
          </p>
          <h1 className="text-4xl font-bold mb-4">My Assets & Licenses</h1>
          <p className="text-zinc-400 mb-8 max-w-md mx-auto">
            Connect your Freighter wallet to view your assets, licenses held,
            revenue earned, and active payment streams.
          </p>
          <button
            onClick={connectWallet}
            disabled={connecting}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-lg font-semibold transition-colors"
          >
            {connecting ? "Connecting..." : "Connect Wallet"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-zinc-800">
          <div>
            <p className="text-sm font-mono text-purple-400 tracking-widest uppercase mb-2">
              Dashboard
            </p>
            <h1 className="text-3xl font-bold">My Assets & Licenses</h1>
          </div>
          <div className="text-right">
            <p className="text-xs text-zinc-500 mb-1">Connected Wallet</p>
            <p className="text-sm font-mono text-zinc-300">
              {shortenKey(publicKey)}
            </p>
            <button
              onClick={disconnectWallet}
              className="text-xs text-red-400 hover:text-red-300 mt-1"
            >
              Disconnect
            </button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "My Assets", value: assets.length },
            { label: "Licenses Held", value: licenses.length },
            {
              label: "Total Revenue",
              value: `${formatXLM(totalRevenue)} XLM`,
            },
            { label: "Active Streams", value: totalStreams },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg"
            >
              <p className="text-xs text-zinc-500 mb-2">{label}</p>
              <p className="text-xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6 border-b border-zinc-800">
          {(["assets", "licenses", "streams"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-purple-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-white"
              }`}
            >
              {tab === "assets"
                ? `My Assets (${assets.length})`
                : tab === "licenses"
                  ? `My Licenses (${licenses.length})`
                  : `Streams (${totalStreams})`}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {loading ? (
          <div className="text-center py-12">
            <p className="text-zinc-400">Loading dashboard data...</p>
          </div>
        ) : (
          <>
            {/* Assets Tab */}
            {activeTab === "assets" && (
              <div>
                {assets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-zinc-400">
                      No assets found for this wallet.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Revenue per asset */}
                    {revenue.length > 0 && (
                      <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
                        <h3 className="font-semibold mb-4">Revenue by Asset</h3>
                        <div className="space-y-3">
                          {revenue.map((r) => (
                            <div
                              key={r.assetId}
                              className="flex items-center justify-between"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-sm truncate">
                                  {r.assetName}
                                </p>
                                <p className="text-xs text-zinc-500">
                                  {r.assetType} &middot; {r.licenseCount}{" "}
                                  license{r.licenseCount !== 1 ? "s" : ""}
                                </p>
                              </div>
                              <p className="font-semibold text-green-400 ml-4">
                                {formatXLM(r.totalRevenue)} XLM
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Asset cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {assets.map((asset) => (
                        <div
                          key={asset.id}
                          className="p-5 bg-zinc-900 border border-zinc-800 rounded-lg"
                        >
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold truncate">{asset.name}</h4>
                              <p className="text-xs text-zinc-500 mt-1">
                                ID: {asset.id}
                              </p>
                            </div>
                            <span
                              className={`px-2 py-1 text-xs rounded-full font-semibold ${
                                asset.licenseType === "OpenSource"
                                  ? "bg-green-500/10 text-green-400"
                                  : "bg-purple-500/10 text-purple-300"
                              }`}
                            >
                              {asset.licenseType}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mb-4">
                            <div>
                              <p className="text-xs text-zinc-500">Type</p>
                              <p className="text-sm font-medium">
                                {asset.assetType}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-zinc-500">Price</p>
                              <p className="text-sm font-medium">
                                {formatXLM(asset.price)} XLM
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-zinc-500">Uses</p>
                              <p className="text-sm font-medium">
                                {asset.usageCount}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-zinc-500">Listed</p>
                              <p className="text-sm font-medium">
                                {formatTimestamp(asset.createdAt)}
                              </p>
                            </div>
                          </div>

                          {/* Quick Actions */}
                          <div className="flex gap-2 pt-3 border-t border-zinc-800">
                            <button
                              onClick={() => handleDelist(asset.id)}
                              disabled={delistingId === asset.id}
                              className="flex-1 px-3 py-1.5 text-xs font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors disabled:opacity-50"
                            >
                              {delistingId === asset.id
                                ? "Delisting..."
                                : "Delist"}
                            </button>
                            {editingPriceId === asset.id ? (
                              <div className="flex gap-1 flex-1">
                                <input
                                  type="number"
                                  value={newPrice}
                                  onChange={(e) => setNewPrice(e.target.value)}
                                  placeholder="New price"
                                  className="flex-1 px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded focus:outline-none focus:border-purple-500"
                                  min="0"
                                />
                                <button
                                  onClick={() => handleUpdatePrice(asset.id)}
                                  disabled={
                                    updatingPriceId === asset.id || !newPrice
                                  }
                                  className="px-2 py-1 text-xs font-semibold bg-purple-600 hover:bg-purple-700 rounded transition-colors disabled:opacity-50"
                                >
                                  {updatingPriceId === asset.id ? "..." : "OK"}
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingPriceId(null);
                                    setNewPrice("");
                                  }}
                                  className="px-2 py-1 text-xs text-zinc-400 hover:text-white rounded"
                                >
                                  X
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setEditingPriceId(asset.id);
                                  setNewPrice(String(asset.price));
                                }}
                                className="flex-1 px-3 py-1.5 text-xs font-semibold bg-zinc-800 text-zinc-300 hover:bg-zinc-700 rounded transition-colors"
                              >
                                Update Price
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Licenses Tab */}
            {activeTab === "licenses" && (
              <div>
                {licenses.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-zinc-400">
                      No licenses held by this wallet.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {licenses.map((license) => (
                      <div
                        key={license.id}
                        className="p-5 bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-between"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-2">
                            <h4 className="font-semibold">
                              Asset #{license.assetId}
                            </h4>
                            <span
                              className={`px-2 py-0.5 text-xs rounded-full font-semibold ${
                                license.licenseType === "OpenSource"
                                  ? "bg-green-500/10 text-green-400"
                                  : license.isActive
                                    ? "bg-purple-500/10 text-purple-300"
                                    : "bg-zinc-700/50 text-zinc-400"
                              }`}
                            >
                              {license.licenseType}
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-4 text-sm">
                            <div>
                              <p className="text-xs text-zinc-500">Paid</p>
                              <p className="font-medium">
                                {formatXLM(license.pricePaid)} XLM
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-zinc-500">
                                Calls Remaining
                              </p>
                              <p className="font-medium">
                                {license.callsRemaining !== null
                                  ? license.callsRemaining
                                  : "Unlimited"}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-zinc-500">Purchased</p>
                              <p className="font-medium">
                                {formatTimestamp(license.purchasedAt)}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="ml-4 text-right">
                          {license.expiresAt ? (
                            <p className="text-xs text-zinc-500">
                              Expires{" "}
                              {formatTimestamp(license.expiresAt)}
                            </p>
                          ) : (
                            <p className="text-xs text-green-500">No Expiry</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Streams Tab */}
            {activeTab === "streams" && (
              <div className="space-y-8">
                {/* Outgoing */}
                <div>
                  <h3 className="text-lg font-semibold mb-4">
                    Outgoing Streams ({streamsOut.length})
                  </h3>
                  {streamsOut.length === 0 ? (
                    <p className="text-zinc-400 text-sm">
                      No outgoing payment streams.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {streamsOut.map((stream) => (
                        <StreamCard
                          key={stream.id}
                          stream={stream}
                          role="sender"
                          formatXLM={formatXLM}
                          formatTimestamp={formatTimestamp}
                          onWithdraw={handleWithdraw}
                          withdrawingId={withdrawingId}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Incoming */}
                <div>
                  <h3 className="text-lg font-semibold mb-4">
                    Incoming Streams ({streamsIn.length})
                  </h3>
                  {streamsIn.length === 0 ? (
                    <p className="text-zinc-400 text-sm">
                      No incoming payment streams.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {streamsIn.map((stream) => (
                        <StreamCard
                          key={stream.id}
                          stream={stream}
                          role="recipient"
                          formatXLM={formatXLM}
                          formatTimestamp={formatTimestamp}
                          onWithdraw={handleWithdraw}
                          withdrawingId={withdrawingId}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function StreamCard({
  stream,
  role,
  formatXLM,
  formatTimestamp,
  onWithdraw,
  withdrawingId,
}: {
  stream: Stream;
  role: "sender" | "recipient";
  formatXLM: (n: number) => string;
  formatTimestamp: (n: number) => string;
  onWithdraw: (streamId: number, amount: number) => void;
  withdrawingId: number | null;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const counterparty =
    role === "sender" ? stream.recipient : stream.sender;
  const elapsed =
    now > stream.startTime ? Math.min(now, stream.endTime) - stream.startTime : 0;
  const totalDuration = stream.endTime - stream.startTime;
  const accrued = elapsed * stream.ratePerSecond;
  const available = Math.max(0, accrued - stream.withdrawn);

  return (
    <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span
            className={`px-2 py-0.5 text-xs rounded-full font-semibold ${
              stream.status === "Active"
                ? "bg-green-500/10 text-green-400"
                : stream.status === "Paused"
                  ? "bg-yellow-500/10 text-yellow-400"
                  : "bg-zinc-700/50 text-zinc-400"
            }`}
          >
            {stream.status}
          </span>
          <span className="text-xs text-zinc-500">#{stream.id}</span>
        </div>
        {role === "recipient" && stream.status === "Active" && available > 0 && (
          <button
            onClick={() => onWithdraw(stream.id, available)}
            disabled={withdrawingId === stream.id}
            className="px-3 py-1.5 text-xs font-semibold bg-green-500/10 text-green-400 hover:bg-green-500/20 rounded transition-colors disabled:opacity-50"
          >
            {withdrawingId === stream.id
              ? "Withdrawing..."
              : `Withdraw ${formatXLM(available)} XLM`}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div>
          <p className="text-xs text-zinc-500">
            {role === "sender" ? "Recipient" : "Sender"}
          </p>
          <p className="font-mono text-xs text-zinc-300">
            {counterparty.slice(0, 16)}...
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Rate</p>
          <p className="font-medium">
            {formatXLM(stream.ratePerSecond)} XLM/s
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Deposit</p>
          <p className="font-medium">{formatXLM(stream.deposit)} XLM</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Withdrawn</p>
          <p className="font-medium">{formatXLM(stream.withdrawn)} XLM</p>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-zinc-800">
        <div className="flex justify-between text-xs text-zinc-500 mb-1">
          <span>{formatTimestamp(stream.startTime * 1000)}</span>
          <span>{formatTimestamp(stream.endTime * 1000)}</span>
        </div>
        <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-purple-500 rounded-full"
            style={{
              width: `${totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 0}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
