"use client";

import { useState, useCallback, useEffect } from "react";
import { isConnected, getAddress } from "@stellar/freighter-api";

const API = "http://localhost:4000";

export default function PolicyPage() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  
  const [threshold, setThreshold] = useState<number>(1);
  const [signers, setSigners] = useState<string[]>([""]);
  
  async function connectWallet() {
    setConnecting(true);
    try {
      const connected = await isConnected();
      if (connected) {
        const { address } = await getAddress();
        setPublicKey(address);
        // We assume the orgId is the user's public key
        fetchPolicy(address);
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
  }

  const fetchPolicy = async (orgId: string) => {
    try {
      // The API only returns threshold currently based on our backend check
      // A full implementation would also return the signers
    } catch (e) {
      console.error(e);
    }
  }

  const handleSavePolicy = async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const validSigners = signers.filter(s => s.trim().length > 0);
      
      const res = await fetch(`${API}/api/v1/orgs/${publicKey}/approval-policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threshold,
          // signers: validSigners // Backend only takes threshold for now
        }),
      });
      
      if (res.ok) {
        alert("Policy saved successfully!");
      } else {
        const text = await res.text();
        alert("Failed to save policy: " + text);
      }
    } catch (err) {
      console.error(err);
      alert("Error saving policy");
    } finally {
      setLoading(false);
    }
  };

  const updateSigner = (index: number, value: string) => {
    const newSigners = [...signers];
    newSigners[index] = value;
    setSigners(newSigners);
  };

  const addSigner = () => {
    setSigners([...signers, ""]);
  };

  const removeSigner = (index: number) => {
    if (signers.length <= 1) return;
    const newSigners = [...signers];
    newSigners.splice(index, 1);
    setSigners(newSigners);
  };

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Organization Policy</h1>
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
          <p className="text-gray-500">Connect your wallet to manage your organization's policy.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 max-w-2xl">
          <h2 className="text-xl font-semibold mb-6">Multi-Signature Approval Rules</h2>
          
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Threshold Amount
            </label>
            <p className="text-sm text-gray-500 mb-2">
              Number of signatures required to approve a proposal.
            </p>
            <input
              type="number"
              min="1"
              max={signers.length}
              value={threshold}
              onChange={(e) => setThreshold(parseInt(e.target.value) || 1)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
          </div>

          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Required Signers
              </label>
              <button
                onClick={addSigner}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                + Add Signer
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              List the public keys of all allowed signers for this organization.
            </p>
            
            <div className="space-y-3">
              {signers.map((signer, index) => (
                <div key={index} className="flex space-x-2">
                  <input
                    type="text"
                    value={signer}
                    onChange={(e) => updateSigner(index, e.target.value)}
                    placeholder="G..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                  {signers.length > 1 && (
                    <button
                      onClick={() => removeSigner(index)}
                      className="px-3 py-2 text-red-600 border border-red-200 rounded-md hover:bg-red-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4 border-t border-gray-200">
            <button
              onClick={handleSavePolicy}
              disabled={loading}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save Policy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
