"use client";
import React from 'react';

export default function ExpiryCountdown({ status }: { status: string }) {
  const isGracePeriod = status === 'grace-period';
  return (
    <div className={`font-mono text-sm ${isGracePeriod ? "text-amber-400" : "text-zinc-400"}`}>
      Expires in: 2d 14h 32m
    </div>
  );
}
