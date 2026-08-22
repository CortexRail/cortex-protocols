"use client";

import { useEffect, useRef, useState } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  resultCount?: number;
}

export function SearchBar({ onSearch, resultCount }: SearchBarProps) {
  const [query, setQuery] = useState("");
  // A timer id doesn't need to trigger a re-render, so it lives in a ref
  // rather than state (which also keeps this out of the effect's own
  // reactive dependencies).
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(() => {
      onSearch(query);
    }, 300);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, onSearch]);

  const handleClear = () => {
    setQuery("");
  };

  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search by name, description, or tags..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 pr-10"
      />
      {query && (
        <button
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
        >
          ✕
        </button>
      )}
      {resultCount !== undefined && query && (
        <p className="mt-2 text-xs text-zinc-400">
          {resultCount} {resultCount === 1 ? "result" : "results"} found
        </p>
      )}
    </div>
  );
}
