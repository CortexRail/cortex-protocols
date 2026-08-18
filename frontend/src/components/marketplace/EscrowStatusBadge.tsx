"use client";

import React from "react";

export type EscrowStatusType = "Held" | "Released" | "Disputed" | "Resolved";

interface EscrowStatusBadgeProps {
  status: EscrowStatusType;
  holdUntilLedger?: number;
  currentLedger?: number;
  className?: string;
}

export default function EscrowStatusBadge({
  status,
  holdUntilLedger,
  currentLedger = 0,
  className = "",
}: EscrowStatusBadgeProps) {
  let badgeStyle = "bg-neutral-800 text-neutral-300 border-neutral-700";
  let label: string = status;

  if (status === "Held") {
    badgeStyle = "bg-amber-950/60 text-amber-300 border-amber-500/40";
    if (holdUntilLedger) {
      const remaining = Math.max(0, holdUntilLedger - currentLedger);
      label = `Funds held until block #${holdUntilLedger} (${remaining} ledgers left)`;
    } else {
      label = "Funds held in escrow";
    }
  } else if (status === "Released") {
    badgeStyle = "bg-emerald-950/60 text-emerald-300 border-emerald-500/40";
    label = "Funds Released";
  } else if (status === "Disputed") {
    badgeStyle = "bg-rose-950/60 text-rose-300 border-rose-500/40";
    label = "Disputed";
  } else if (status === "Resolved") {
    badgeStyle = "bg-indigo-950/60 text-indigo-300 border-indigo-500/40";
    label = "Arbitration Resolved";
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border ${badgeStyle} ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
