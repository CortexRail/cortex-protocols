import { useState } from "react";

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

interface ProposalDetailProps {
  proposal: Proposal;
  publicKey: string;
  onApprove: () => void;
}

export default function ProposalDetail({ proposal, publicKey, onApprove }: ProposalDetailProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const isExpired = new Date() > new Date(proposal.expires_at);
  const timeLeftMs = new Date(proposal.expires_at).getTime() - new Date().getTime();
  const daysLeft = Math.max(0, Math.floor(timeLeftMs / (1000 * 60 * 60 * 24)));
  const hoursLeft = Math.max(0, Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)));

  const handleAction = async (action: "approve" | "reject") => {
    if (action === "approve") setApproving(true);
    else setRejecting(true);

    try {
      const res = await fetch(`${API}/api/v1/proposals/${proposal.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signer: publicKey }),
      });

      if (res.ok) {
        alert(`Successfully ${action}d proposal!`);
        onApprove();
      } else {
        const text = await res.text();
        alert(`Failed to ${action} proposal: ` + text);
      }
    } catch (err) {
      console.error(err);
      alert(`Error trying to ${action} proposal`);
    } finally {
      setApproving(false);
      setRejecting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Proposal #{proposal.id}
          </h3>
          <p className="text-sm text-gray-500">
            Asset ID: {proposal.asset_id} (Version: {proposal.asset_version})
          </p>
        </div>
        <div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              isExpired
                ? "bg-red-100 text-red-800"
                : "bg-yellow-100 text-yellow-800"
            }`}
          >
            {isExpired ? "Expired" : "Pending Action"}
          </span>
        </div>
      </div>
      
      <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-sm text-gray-500">Proposed Buyer</p>
          <p className="font-mono text-sm break-all">{proposal.buyer}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500">Price</p>
          <p className="font-medium">{proposal.price} XLM</p>
        </div>
        
        <div>
          <p className="text-sm text-gray-500">Status</p>
          <p className="capitalize">{proposal.status}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500">Expires In</p>
          <p className={isExpired ? "text-red-600 font-medium" : "text-gray-900"}>
            {isExpired 
              ? "Expired" 
              : `${daysLeft} days, ${hoursLeft} hours`}
          </p>
        </div>
      </div>

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3">
        <button
          onClick={() => handleAction("reject")}
          disabled={approving || rejecting || isExpired}
          className="px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {rejecting ? "Rejecting..." : "Reject"}
        </button>
        <button
          onClick={() => handleAction("approve")}
          disabled={approving || rejecting || isExpired}
          className="px-4 py-2 bg-blue-600 border border-transparent rounded-md text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {approving ? "Approving..." : "Approve Proposal"}
        </button>
      </div>
    </div>
  );
}
