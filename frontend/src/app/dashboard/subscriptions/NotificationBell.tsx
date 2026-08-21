"use client";
import React, { useState } from 'react';
import NotificationDrawer from './NotificationDrawer';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="p-2 border rounded-full relative">
        ?? <span className="absolute top-0 right-0 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center">1</span>
      </button>
      {open && <NotificationDrawer onClose={() => setOpen(false)} />}
    </div>
  );
}
