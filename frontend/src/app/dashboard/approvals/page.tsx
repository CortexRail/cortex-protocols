"use client";

import { useState, useCallback, useEffect } from "react";
import { isConnected, getAddress } from "@stellar/freighter-api";
import ProposalDetail from "./ProposalDetail";

const API = "http://localhost:4000";

interface Proposal {
  id: number;
  org_id: string;
  asset_id: number;
  asset_version: number;
  buyer: string;
  price: string;
  status: string;
  created_at: string;
  expires_at: string;
}

export default function ApprovalsPage() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const fetchProposals = useCallback(async (pk: string) => {
    setLoading(true);
    try {
      // Assuming pk is the orgId for this demo or we use pk to fetch all proposals
      const res = await fetch(`${API}/api/v1/orgs/${pk}/proposals`);
      if (res.ok) {
        const d = await res.json();
        setProposals(d || []);
      }
    } catch (err) {
      console.error("Failed to fetch proposals:", err);
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
        await fetchProposals(address);
      } else {
        alert("Freighter wallet not found.");
      }
    } catch (err) {
      console.error("Wallet connection failed:", err);
    } finally {
      setConnecting(false);
    }
  }

  function disconnectWallet() {
    setPublicKey(null);
    setProposals([]);
  }

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Approval Inbox</h1>
        <div>
          {publicKey ? (
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">
                {publicKey.slice(0, 6)}...{publicKey.slice(-4)}
              </span>
              <button
                onClick={disconnectWallet}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connectWallet}
              disabled={connecting}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {connecting ? "Connecting..." : "Connect Wallet"}
            </button>
          )}
        </div>
      </div>

      {!publicKey ? (
        <div className="text-center py-12 bg-white rounded-lg shadow-sm border border-gray-200">
          <p className="text-gray-500">Connect your wallet to view pending approvals.</p>
        </div>
      ) : loading ? (
        <div className="text-center py-12 bg-white rounded-lg shadow-sm border border-gray-200">
          <p className="text-gray-500">Loading proposals...</p>
        </div>
      ) : proposals.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow-sm border border-gray-200">
          <p className="text-gray-500">No pending approvals require your signature.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {proposals.map((proposal) => (
            <ProposalDetail
              key={proposal.id}
              proposal={proposal}
              publicKey={publicKey}
              onApprove={() => fetchProposals(publicKey)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
