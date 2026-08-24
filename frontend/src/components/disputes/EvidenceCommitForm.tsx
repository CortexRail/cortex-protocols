'use client';

import React, { useState } from 'react';

interface EvidenceCommitFormProps {
  disputeId: string;
  role: 'buyer' | 'seller';
  onSubmitCommit: (hash: string, saltHex: string, evidenceText: string) => Promise<void>;
}

export function EvidenceCommitForm({ disputeId, role, onSubmitCommit }: EvidenceCommitFormProps) {
  const [evidenceText, setEvidenceText] = useState('');
  const [generatedSalt, setGeneratedSalt] = useState('');
  const [computedHash, setComputedHash] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const generateSaltAndHash = async () => {
    if (!evidenceText.trim()) return;

    // Generate random 32-byte salt hex
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const saltHex = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    setGeneratedSalt(saltHex);

    // Compute SHA-256 (evidenceText + saltHex)
    const encoder = new TextEncoder();
    const evBuf = encoder.encode(evidenceText);
    const saltBuf = new Uint8Array(saltHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

    const combined = new Uint8Array(evBuf.length + saltBuf.length);
    combined.set(evBuf);
    combined.set(saltBuf, evBuf.length);

    const hashBuf = await crypto.subtle.digest('SHA-256', combined);
    const hashHex = Array.from(new Uint8Array(hashBuf), b => b.toString(16).padStart(2, '0')).join('');
    setComputedHash(hashHex);

    // Persist salt locally in browser localStorage for reveal phase
    localStorage.setItem(`dispute_salt_${disputeId}_${role}`, saltHex);
    localStorage.setItem(`dispute_evidence_${disputeId}_${role}`, evidenceText);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!computedHash || !generatedSalt) return;
    setLoading(true);
    try {
      await onSubmitCommit(computedHash, generatedSalt, evidenceText);
      setSubmitted(true);
    } catch (err: any) {
      alert(`Commit error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl text-white max-w-xl">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-indigo-400">
          {role === 'buyer' ? 'Submit Buyer Claim Commitment' : 'Submit Seller Response Commitment'}
        </h3>
        <span className="text-xs px-2.5 py-1 bg-indigo-950 text-indigo-300 border border-indigo-700/50 rounded-full">
          Commit-Reveal Phase
        </span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Evidence Details (Plain Text)
          </label>
          <textarea
            rows={4}
            value={evidenceText}
            onChange={(e) => {
              setEvidenceText(e.target.value);
              setComputedHash('');
            }}
            placeholder="Describe your dispute grounds, missing deliverables, or audit logs..."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            required
          />
        </div>

        <button
          type="button"
          onClick={generateSaltAndHash}
          disabled={!evidenceText.trim()}
          className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-semibold text-slate-200 rounded-lg border border-slate-700 transition-all"
        >
          🔑 Generate Client Salt & Compute SHA-256 Commitment Hash
        </button>

        {computedHash && (
          <div className="space-y-2 bg-slate-950 p-4 rounded-lg border border-slate-800 text-xs font-mono">
            <div>
              <span className="text-slate-400">SHA-256 Hash:</span>
              <p className="text-emerald-400 break-all">{computedHash}</p>
            </div>
            <div>
              <span className="text-slate-400">Secret Salt (Stored Locally):</span>
              <p className="text-amber-400 break-all">{generatedSalt}</p>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={!computedHash || loading || submitted}
          className="w-full py-3 px-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-sm font-semibold rounded-lg shadow-lg disabled:opacity-50 transition-all"
        >
          {loading ? 'Submitting Commitment...' : submitted ? 'Commitment Submitted ✓' : 'Commit Hash to Ledger'}
        </button>
      </form>
    </div>
  );
}
