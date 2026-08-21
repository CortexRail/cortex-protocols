"use client";
import React, { createContext, useContext } from 'react';

const NotificationContext = createContext({});

export const NotificationProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <NotificationContext.Provider value={{}}>
      {children}
    </NotificationContext.Provider>
  );
};
