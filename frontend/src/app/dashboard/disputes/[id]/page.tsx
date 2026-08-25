'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { EvidenceCommitForm } from '@/components/disputes/EvidenceCommitForm';

export default function DisputeDetailPage() {
  const params = useParams();
  const disputeId = (params?.id as string) || '1';

  const [dispute, setDispute] = useState<any>({
    id: disputeId,
    assetId: 101,
    assetName: 'GPT-4 Reasoning Chain Asset',
    buyer: 'GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    seller: 'GSELLERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    round: 1,
    maxRounds: 4,
    phase: 'COMMIT', // COMMIT, REVEAL, ESCALATION, ARBITRATION, RESOLVED
    buyerBond: '100.0 XLM',
    sellerBond: '100.0 XLM',
    totalBondAtRisk: '200.0 XLM',
    buyerClaimHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    sellerResponseHash: null,
    buyerRevealed: false,
    sellerRevealed: false,
    buyerEscalated: false,
    sellerEscalated: false,
    outcome: 'NONE',
    phaseDeadlineSeconds: 86400,
  });

  const [timeLeft, setTimeLeft] = useState(dispute.phaseDeadlineSeconds);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev: number) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleCommit = async (hash: string, salt: string, text: string) => {
    setDispute((prev: any) => ({
      ...prev,
      sellerResponseHash: hash,
      phase: 'REVEAL',
    }));
  };

  const handleReveal = async (role: 'buyer' | 'seller') => {
    const storedSalt = localStorage.getItem(`dispute_salt_${disputeId}_${role}`) || '1111111111111111111111111111111111111111111111111111111111111111';
    const storedEvidence = localStorage.getItem(`dispute_evidence_${disputeId}_${role}`) || 'Sample evidence text payload';

    setDispute((prev: any) => {
      const updated = { ...prev };
      if (role === 'buyer') updated.buyerRevealed = true;
      if (role === 'seller') updated.sellerRevealed = true;
      if (updated.buyerRevealed && updated.sellerRevealed) {
        updated.phase = 'ESCALATION';
      }
      return updated;
    });
  };

  const handleEscalate = async (role: 'buyer' | 'seller') => {
    setDispute((prev: any) => {
      const updated = { ...prev };
      if (role === 'buyer') updated.buyerEscalated = true;
      if (role === 'seller') updated.sellerEscalated = true;
      if (updated.buyerEscalated && updated.sellerEscalated) {
        updated.round += 1;
        updated.buyerEscalated = false;
        updated.sellerEscalated = false;
        updated.buyerBond = `${parseFloat(updated.buyerBond) * 2} XLM`;
        updated.sellerBond = `${parseFloat(updated.sellerBond) * 2} XLM`;
        updated.totalBondAtRisk = `${parseFloat(updated.totalBondAtRisk) * 2} XLM`;
        if (updated.round >= 4) {
          updated.phase = 'ARBITRATION';
        } else {
          updated.phase = 'COMMIT';
        }
      }
      return updated;
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8 space-y-8 font-sans">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-2xl">
        <div>
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-semibold rounded-full uppercase tracking-wider">
              Dispute #{dispute.id}
            </span>
            <span className="text-xs text-slate-400">Round {dispute.round} of {dispute.maxRounds}</span>
          </div>
          <h1 className="text-2xl font-bold text-white mt-1">{dispute.assetName}</h1>
          <p className="text-xs text-slate-400 mt-0.5">Asset ID: {dispute.assetId}</p>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-xs text-slate-400">Total Bond Collateral At Risk</div>
            <div className="text-xl font-extrabold text-amber-400">{dispute.totalBondAtRisk}</div>
          </div>
          <div className="bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-center">
            <div className="text-xs text-slate-400 uppercase tracking-wider">Phase Clock</div>
            <div className="text-lg font-mono font-bold text-indigo-400">{formatTime(timeLeft)}</div>
          </div>
        </div>
      </div>

      {/* Multi-Round Progress Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Dispute Resolution Stage</h2>
        <div className="grid grid-cols-5 gap-2 text-center text-xs">
          {['COMMIT', 'REVEAL', 'ESCALATION', 'ARBITRATION', 'RESOLVED'].map((stage, idx) => {
            const isCurrent = dispute.phase === stage;
            const isCompleted = ['COMMIT', 'REVEAL', 'ESCALATION', 'ARBITRATION', 'RESOLVED'].indexOf(dispute.phase) > idx;
            return (
              <div
                key={stage}
                className={`p-3 rounded-lg border transition-all ${
                  isCurrent
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300 font-bold shadow-lg shadow-indigo-500/10'
                    : isCompleted
                    ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400'
                    : 'bg-slate-950 border-slate-800 text-slate-500'
                }`}
              >
                <div>Round {idx + 1}</div>
                <div className="mt-1 font-mono uppercase">{stage}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bonds & Stakes Comparison */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">Buyer Stake</span>
            <span className="text-sm font-bold text-white">{dispute.buyerBond}</span>
          </div>
          <p className="text-xs text-slate-400 break-all">Address: {dispute.buyer}</p>
          <div className="text-xs bg-slate-950 p-3 rounded-lg border border-slate-800 font-mono">
            Claim Hash: {dispute.buyerClaimHash.substring(0, 24)}...
          </div>
          <div className="pt-2">
            {dispute.phase === 'REVEAL' && (
              <button
                onClick={() => handleReveal('buyer')}
                disabled={dispute.buyerRevealed}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white rounded-lg transition-all"
              >
                {dispute.buyerRevealed ? 'Buyer Evidence Revealed ✓' : 'Reveal Buyer Evidence'}
              </button>
            )}
            {dispute.phase === 'ESCALATION' && (
              <button
                onClick={() => handleEscalate('buyer')}
                disabled={dispute.buyerEscalated}
                className="w-full py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-xs font-semibold text-white rounded-lg transition-all"
              >
                {dispute.buyerEscalated ? 'Buyer Bond Doubled ✓' : 'Escalate & Double Buyer Bond'}
              </button>
            )}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-purple-400">Seller Collateral</span>
            <span className="text-sm font-bold text-white">{dispute.sellerBond}</span>
          </div>
          <p className="text-xs text-slate-400 break-all">Address: {dispute.seller}</p>
          <div className="text-xs bg-slate-950 p-3 rounded-lg border border-slate-800 font-mono">
            Response Hash: {dispute.sellerResponseHash ? `${dispute.sellerResponseHash.substring(0, 24)}...` : 'Awaiting Seller Response'}
          </div>
          <div className="pt-2">
            {dispute.phase === 'REVEAL' && (
              <button
                onClick={() => handleReveal('seller')}
                disabled={dispute.sellerRevealed}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white rounded-lg transition-all"
              >
                {dispute.sellerRevealed ? 'Seller Evidence Revealed ✓' : 'Reveal Seller Evidence'}
              </button>
            )}
            {dispute.phase === 'ESCALATION' && (
              <button
                onClick={() => handleEscalate('seller')}
                disabled={dispute.sellerEscalated}
                className="w-full py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-xs font-semibold text-white rounded-lg transition-all"
              >
                {dispute.sellerEscalated ? 'Seller Bond Doubled ✓' : 'Escalate & Double Seller Bond'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Commit Form Section (Shown in COMMIT phase) */}
      {dispute.phase === 'COMMIT' && !dispute.sellerResponseHash && (
        <div className="flex justify-center">
          <EvidenceCommitForm
            disputeId={disputeId}
            role="seller"
            onSubmitCommit={handleCommit}
          />
        </div>
      )}
    </div>
  );
}
