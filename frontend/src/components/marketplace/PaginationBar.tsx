"use client";

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50];

export function PaginationBar({
  currentPage,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-6 border-t border-zinc-800">
      {/* Left: Page size selector */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-zinc-400">Show:</label>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="px-2 py-1 bg-zinc-900 border border-zinc-800 rounded text-sm text-white focus:outline-none focus:border-purple-500"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </select>
      </div>

      {/* Center: Page navigation */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="px-3 py-1 text-sm bg-zinc-900 border border-zinc-800 rounded text-white disabled:opacity-50 hover:border-purple-500 transition-colors"
        >
          ← Prev
        </button>

        {/* Page numbers */}
        <div className="flex items-center gap-1">
          {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
            const pageNum =
              currentPage <= 3
                ? i + 1
                : Math.max(1, currentPage - 2) + i;

            if (pageNum > totalPages) return null;

            return (
              <button
                key={pageNum}
                onClick={() => onPageChange(pageNum)}
                className={`px-2 py-1 text-sm rounded transition-colors ${
                  pageNum === currentPage
                    ? "bg-purple-600 text-white"
                    : "bg-zinc-900 border border-zinc-800 text-white hover:border-purple-500"
                }`}
              >
                {pageNum}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="px-3 py-1 text-sm bg-zinc-900 border border-zinc-800 rounded text-white disabled:opacity-50 hover:border-purple-500 transition-colors"
        >
          Next →
        </button>
      </div>

      {/* Right: Page info */}
      <div className="text-sm text-zinc-400">
        Page {currentPage} of {totalPages}
      </div>
    </div>
  );
}
