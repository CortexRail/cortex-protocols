"use client";

import { createContext, useContext, ReactNode } from "react";
// Assuming the generated clients export a Client class
import { Client as MarketplaceClient } from "@/lib/contracts/marketplace";
import { Client as MicropaymentsClient } from "@/lib/contracts/micropayments";
import { Client as AgentRegistryClient } from "@/lib/contracts/agent_registry";

interface ContractContextValue {
  marketplace: MarketplaceClient | null;
  micropayments: MicropaymentsClient | null;
  agentRegistry: AgentRegistryClient | null;
}

const ContractContext = createContext<ContractContextValue>({
  marketplace: null,
  micropayments: null,
  agentRegistry: null,
});

export function useContracts() {
  return useContext(ContractContext);
}

export function ContractProvider({
  children,
  network = "testnet",
  rpcUrl,
}: {
  children: ReactNode;
  network?: string;
  rpcUrl?: string;
}) {
  // The clients typically require network details to instantiate, but might also just need a Contract ID or RPC URL.
  // We'll instantiate them here (or you can pass config per your environment).
  const marketplace = new MarketplaceClient({ network, rpcUrl });
  const micropayments = new MicropaymentsClient({ network, rpcUrl });
  const agentRegistry = new AgentRegistryClient({ network, rpcUrl });

  return (
    <ContractContext.Provider value={{ marketplace, micropayments, agentRegistry }}>
      {children}
    </ContractContext.Provider>
  );
}
