"use client";
import React from 'react';

export default function CancelModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
      <div className="bg-white p-6 rounded-lg max-w-sm w-full">
        <h2 className="text-xl font-bold mb-4">Cancel Subscription</h2>
        <p className="mb-4">You will retain access until your original expiry date.</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded">Keep</button>
          <button className="px-4 py-2 bg-red-600 text-white rounded">Confirm Cancel</button>
        </div>
      </div>
    </div>
  );
}
