"use client";
import React from 'react';
import PlanSelector from './PlanSelector';

export default function RenewModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
      <div className="bg-white p-6 rounded-lg max-w-md w-full">
        <h2 className="text-xl font-bold mb-4">Renew Subscription</h2>
        <PlanSelector />
        <div className="mt-4 p-4 bg-gray-50 rounded">
          <p>Prorated Calculation will appear here.</p>
        </div>
        <div className="flex gap-2 justify-end mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded">Cancel</button>
          <button className="px-4 py-2 bg-blue-600 text-white rounded">Sign & Submit (Freighter)</button>
        </div>
      </div>
    </div>
  );
}
