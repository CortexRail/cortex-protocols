// Formatting utilities for marketplace display

export function stroopsToXlm(stroops: number): number {
  return stroops / 10_000_000;
}

export function formatPrice(stroops: number): string {
  const xlm = stroopsToXlm(stroops);
  return `${xlm.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 7,
  })} XLM`;
}

export function formatCompactNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return String(num);
}

export function truncateAddress(addr: string, chars: number = 6): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function truncateText(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function getLicenseColor(license: string): string {
  const colors: Record<string, string> = {
    CC0: "bg-blue-500/10 text-blue-400",
    MIT: "bg-green-500/10 text-green-400",
    Apache2: "bg-orange-500/10 text-orange-400",
    Custom: "bg-purple-500/10 text-purple-400",
  };
  return colors[license] || "bg-zinc-500/10 text-zinc-400";
}

export function getAssetTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    prompt: "💭",
    workflow: "⚙️",
    reasoning: "🧠",
    agent: "🤖",
    dataset: "📊",
    model: "🧬",
    integration: "🔗",
    template: "📋",
  };
  return icons[type] || "📦";
}

export function getReputationColor(rep: number): string {
  if (rep < 40) return "text-red-500";
  if (rep < 70) return "text-yellow-500";
  return "text-green-500";
}

export function getReputationBg(rep: number): string {
  if (rep < 40) return "bg-red-500/10";
  if (rep < 70) return "bg-yellow-500/10";
  return "bg-green-500/10";
}
