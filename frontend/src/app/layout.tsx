import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";
import { ContractProvider } from "@/components/ContractProvider";
import Navbar from "@/components/Navbar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Intelligence Rail — Cortex Protocol",
  description:
    "Open marketplace for autonomous AI agent intelligence assets. Discover, exchange, and monetize prompts, workflows, and reasoning chains via Stellar micropayments.",
  keywords: [
    "AI agents",
    "intelligence marketplace",
    "Stellar",
    "Soroban",
    "micropayments",
    "prompt marketplace",
  ],
  openGraph: {
    title: "Intelligence Rail — Cortex Protocol",
    description:
      "Open infrastructure for autonomous agents to discover, exchange, and evolve intelligence assets through programmable micropayments.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{
          __html: `(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}if(t==="dark"){document.documentElement.classList.add("dark")}}catch(e){}})()`
        }} />
      </head>
      <body>
        <ThemeProvider>
          <ContractProvider
            network={process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet"}
            rpcUrl={process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"}
          >
            <Navbar />
            {children}
          </ContractProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
