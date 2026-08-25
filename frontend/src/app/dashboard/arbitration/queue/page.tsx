'use client';

import React, { useState } from 'react';

interface DocketItem {
  id: string;
  assetName: 'GPT-4 Reasoning Chain Asset';
  buyer: string;
  seller: string;
  totalBond: string;
  round: number;
  buyerEvidence: string;
  sellerEvidence: string;
  vrfSeed: string;
}

export default function ArbiterQueuePage() {
  const [docket, setDocket] = useState<DocketItem[]>([
    {
      id: '1',
      assetName: 'GPT-4 Reasoning Chain Asset',
      buyer: 'GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      seller: 'GSELLERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      totalBond: '800.0 XLM',
      round: 4,
      buyerEvidence: 'Output generated contained non-deterministic hallucinations violating specification SLA section 3.2.',
      sellerEvidence: 'API server logs show model temperature was configured to 0.0 per instruction parameters.',
      vrfSeed: 'a3f890b219e48d... (VRF Verified)',
    },
  ]);

  const [selectedRuling, setSelectedRuling] = useState<{ [id: string]: string }>({});

  const handleArbitrate = (id: string, ruling: 'BUYER_WINS' | 'SELLER_WINS' | 'SPLIT') => {
    alert(`Submitted ruling [${ruling}] for Dispute #${id}. Bond slashed and transferred to winner + treasury fee.`);
    setDocket(prev => prev.filter(item => item.id !== id));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8 space-y-8 font-sans">
      <div className="flex items-center justify-between border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Staked Arbiter Docket</h1>
          <p className="text-xs text-slate-400 mt-1">
            Human arbitration queue for Round 4 escalated disputes. Adjudicate evidence to execute bond slashing.
          </p>
        </div>
        <div className="bg-indigo-950/40 border border-indigo-700/50 px-4 py-2 rounded-xl text-right">
          <span className="text-xs text-indigo-300">Your Active Arbiter Stake</span>
          <div className="text-lg font-bold text-indigo-400">5,000.0 XLM</div>
        </div>
      </div>

      {docket.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center text-slate-400">
          🎉 No pending disputes requiring arbitration. All dockets resolved.
        </div>
      ) : (
        <div className="space-y-6">
          {docket.map((item) => (
            <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <span className="px-3 py-1 bg-purple-500/10 text-purple-400 border border-purple-500/20 text-xs font-semibold rounded-full uppercase">
                    Round {item.round} Final Arbitration
                  </span>
                  <h2 className="text-xl font-bold text-white mt-2">Dispute #{item.id} — {item.assetName}</h2>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-400">Total Collateral Slashed At Risk</div>
                  <div className="text-2xl font-extrabold text-amber-400">{item.totalBond}</div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-6 bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div className="space-y-2">
                  <span className="text-xs font-bold text-indigo-400 uppercase">Buyer Claim Evidence</span>
                  <p className="text-xs text-slate-300 bg-slate-900 p-3 rounded-lg border border-slate-800">
                    {item.buyerEvidence}
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono break-all">Buyer: {item.buyer}</p>
                </div>
                <div className="space-y-2">
                  <span className="text-xs font-bold text-purple-400 uppercase">Seller Defense Evidence</span>
                  <p className="text-xs text-slate-300 bg-slate-900 p-3 rounded-lg border border-slate-800">
                    {item.sellerEvidence}
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono break-all">Seller: {item.seller}</p>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-slate-800 pt-4">
                <span className="text-xs text-slate-500 font-mono">VRF Seed: {item.vrfSeed}</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleArbitrate(item.id, 'BUYER_WINS')}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white rounded-lg transition-all shadow-lg"
                  >
                    Rule Buyer Wins (Slash Seller)
                  </button>
                  <button
                    onClick={() => handleArbitrate(item.id, 'SELLER_WINS')}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white rounded-lg transition-all shadow-lg"
                  >
                    Rule Seller Wins (Slash Buyer)
                  </button>
                  <button
                    onClick={() => handleArbitrate(item.id, 'SPLIT')}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-xs font-bold text-slate-200 rounded-lg transition-all"
                  >
                    Split / Refund
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
