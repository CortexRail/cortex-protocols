"use client";

import Link from "next/link";
import { useTheme } from "@/components/ThemeProvider";

export default function Navbar() {
  const { theme, setTheme } = useTheme();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--border)] bg-[var(--background)]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold">
          Intelligence Rail
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors">
            Agents
          </Link>
          <Link href="/agents/leaderboard" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors">
            Leaderboard
          </Link>
          <Link href="/streams" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors">
            Streams
          </Link>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Toggle theme"
          >
            <svg className="hidden dark:block" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            <svg className="block dark:hidden" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
        </div>
      </div>
    </nav>
  );
}
