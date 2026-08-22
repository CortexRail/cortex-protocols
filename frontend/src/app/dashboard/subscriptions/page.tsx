"use client";
import React, { useState } from 'react';
import SubscriptionCard from './SubscriptionCard';
import NotificationBell from './NotificationBell';

export default function SubscriptionsDashboard() {
  const [activeTab, setActiveTab] = useState('active');

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Subscription Management</h1>
        <NotificationBell />
      </div>

      <div className="flex gap-4 border-b mb-6">
        {['active', 'expiring', 'expired', 'cancelled'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === tab
                ? "border-purple-500 text-white"
                : "border-transparent text-zinc-400 hover:text-white"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Placeholder cards */}
        <SubscriptionCard assetName="AI Workflow Analyzer" status={activeTab} />
      </div>
    </div>
  );
}
