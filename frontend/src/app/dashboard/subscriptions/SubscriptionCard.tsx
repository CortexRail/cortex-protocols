"use client";
import React, { useState } from 'react';
import ExpiryCountdown from './ExpiryCountdown';
import RenewModal from './RenewModal';
import CancelModal from './CancelModal';
import SubscriptionTimeline from './SubscriptionTimeline';

export default function SubscriptionCard({ assetName, status }: { assetName: string, status: string }) {
  const [showRenew, setShowRenew] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  return (
    <div className="border rounded-lg p-6 shadow-sm">
      <div className="flex justify-between items-start mb-4">
        <h3 className="font-bold text-lg">{assetName}</h3>
        <span className="px-2 py-1 text-xs rounded-full bg-gray-100 uppercase">{status}</span>
      </div>
      
      <div className="mb-4">
        <ExpiryCountdown status={status} />
      </div>

      <SubscriptionTimeline />

      <div className="mt-6 flex gap-2">
        <button onClick={() => setShowRenew(true)} className="bg-blue-600 text-white px-4 py-2 rounded">Renew / Change Plan</button>
        {status !== 'cancelled' && (
           <button onClick={() => setShowCancel(true)} className="border border-red-600 text-red-600 px-4 py-2 rounded">Cancel</button>
        )}
      </div>

      {showRenew && <RenewModal onClose={() => setShowRenew(false)} />}
      {showCancel && <CancelModal onClose={() => setShowCancel(false)} />}
    </div>
  );
}
