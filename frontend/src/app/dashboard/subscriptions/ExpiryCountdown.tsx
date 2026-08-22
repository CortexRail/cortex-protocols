"use client";
import React from 'react';

export default function ExpiryCountdown({ status: _status }: { status?: string }) {
  return (
    <div className="font-mono">
      Expires in: 2d 14h 32m
    </div>
  );
}
