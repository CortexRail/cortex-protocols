"use client";
import React from 'react';

export default function NotificationDrawer({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute right-0 mt-2 w-64 bg-white border rounded shadow-lg p-4 z-10">
      <div className="flex items-center justify-between border-b pb-2 mb-2">
        <h4 className="font-bold">Notifications</h4>
        <button
          onClick={onClose}
          aria-label="Close notifications"
          className="text-gray-500 hover:text-gray-800"
        >
          ×
        </button>
      </div>
      <div className="text-sm">
        <p className="py-2 border-b">Your subscription to AI Workflow Analyzer is expiring in 7 days.</p>
      </div>
    </div>
  );
}
