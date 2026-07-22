import Link from "next/link";

interface AssetCardProps {
  id: string;
  name: string;
  type: string;
  price: number;
  description: string;
  version?: number;
  isActive?: boolean;
}

function formatPrice(price: number) {
  return `${price.toLocaleString()} stroops`;
}

export default function AssetCard({
  id,
  name,
  type,
  price,
  description,
  version = 1,
  isActive = true,
}: AssetCardProps) {
  return (
    <Link href={`/marketplace/${id}`} className="group">
      <article className="flex h-full flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-6 transition-colors group-hover:border-purple-500">
        <div className="mb-5 flex items-center justify-between gap-3">
          <span className="rounded-full bg-purple-500/15 px-3 py-1 text-xs font-semibold text-purple-300">
            Version {version}
          </span>
          <span className={`text-xs font-medium ${isActive ? "text-green-400" : "text-zinc-500"}`}>
            {isActive ? "Active" : "Inactive"}
          </span>
        </div>
        <h2 className="text-xl font-bold transition-colors group-hover:text-purple-400">
          {name}
        </h2>
        <div className="mt-2 flex items-center gap-2">
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            {type}
          </span>
        </div>
        <p className="mt-3 line-clamp-3 flex-1 text-sm leading-6 text-zinc-400">
          {description}
        </p>
        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-zinc-800 pt-5 text-sm">
          <div>
            <dt className="text-xs text-zinc-500">Price</dt>
            <dd className="mt-1 font-semibold">{formatPrice(price)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Type</dt>
            <dd className="mt-1 font-semibold">{type}</dd>
          </div>
        </dl>
      </article>
    </Link>
  );
}
