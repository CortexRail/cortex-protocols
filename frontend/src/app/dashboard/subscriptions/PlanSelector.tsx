"use client";
import React from 'react';

export default function PlanSelector() {
  return (
    <div className="flex gap-2 mb-4">
      <div className="border p-2 rounded flex-1 cursor-pointer hover:border-blue-500">Monthly</div>
      <div className="border p-2 rounded flex-1 cursor-pointer hover:border-blue-500 bg-blue-50">Quarterly</div>
      <div className="border p-2 rounded flex-1 cursor-pointer hover:border-blue-500">Annual</div>
    </div>
  );
}
