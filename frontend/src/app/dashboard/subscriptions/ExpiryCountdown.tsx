"use client";
import React from 'react';

export default function ExpiryCountdown({ status }: { status: string }) {
  const isGracePeriod = status === 'grace-period';
  return (
    <div className={\ont-mono \\}>
      Expires in: 2d 14h 32m
    </div>
  );
}
