"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WatchWalletChanges } from "@stellar/freighter-api";

import {
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  LICENSE_TYPES,
  LICENSE_TYPE_LABELS,
  NAME_MAX,
  DESCRIPTION_MAX,
  TARGET_NETWORK_LABEL,
  networkLabel,
} from "@/lib/constants";
import {
  validateListing,
  type FieldErrors,
  type ListingFormValues,
} from "@/lib/validation";
import { stroopsToXlm } from "@/lib/stroops";
import {
  connectWallet,
  signWithFreighter,
  networkMatches,
  FreighterError,
  type WalletConnection,
} from "@/lib/freighter";
import { buildListAsset, submitListAsset, ApiError } from "@/lib/api";

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

type Status = "idle" | "building" | "signing" | "submitting" | "success";

const STATUS_LABELS: Record<Exclude<Status, "idle" | "success">, string> = {
  building: "Building transaction…",
  signing: "Waiting for signature in Freighter…",
  submitting: "Submitting to Stellar…",
};

const EMPTY_FORM: ListingFormValues = {
  name: "",
  description: "",
  assetType: "",
  licenseType: "",
  priceXlm: "",
};

export default function NewAssetPage() {
  const router = useRouter();
  const [form, setForm] = useState<ListingFormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [formError, setFormError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const watcherRef = useRef<WatchWalletChanges | null>(null);

  const busy = status !== "idle" && status !== "success";
  const onCorrectNetwork = networkMatches(wallet?.network);
  const canSubmit = !busy && !!wallet && onCorrectNetwork;

  // Keep the wallet address + network in sync when the user changes them in
  // Freighter (e.g. switching from Mainnet to Testnet), without a reconnect.
  useEffect(() => {
    return () => watcherRef.current?.stop();
  }, []);

  async function handleConnect() {
    setWalletError(null);
    setConnecting(true);
    try {
      const connection = await connectWallet();
      setWallet(connection);

      // Start watching for account/network changes.
      watcherRef.current?.stop();
      const watcher = new WatchWalletChanges(2000);
      watcher.watch(({ address, network, networkPassphrase, error }) => {
        if (error || !address) return;
        setWallet({ address, network, networkPassphrase });
      });
      watcherRef.current = watcher;
    } catch (err) {
      setWalletError(
        err instanceof FreighterError
          ? err.message
          : "Could not connect to Freighter. Please try again."
      );
    } finally {
      setConnecting(false);
    }
  }

  const priceStroops = useMemo(() => {
    const { priceStroops } = validateListing(form);
    return priceStroops;
  }, [form]);

  function update<K extends keyof ListingFormValues>(
    field: K,
    value: ListingFormValues[K]
  ) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear a field-level error as soon as the user edits it.
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    // Wallet must be connected and on the target network before we build.
    if (!wallet) {
      setFormError("Connect your Freighter wallet to list an asset.");
      return;
    }
    if (!onCorrectNetwork) {
      setFormError(
        `Freighter is on ${networkLabel(wallet.network)}. Switch it to ${TARGET_NETWORK_LABEL} to list an asset.`
      );
      return;
    }

    const result = validateListing(form);
    if (!result.valid || result.priceStroops === undefined) {
      setErrors(result.errors);
      return;
    }
    setErrors({});

    const priceStr = result.priceStroops.toString();
    const owner = wallet.address;

    try {
      const payload = {
        owner,
        name: form.name.trim(),
        description: form.description.trim(),
        assetType: form.assetType,
        licenseType: form.licenseType,
        price: priceStr,
      };

      // 1. Backend builds & simulates the unsigned list_asset transaction.
      setStatus("building");
      const { xdr, networkPassphrase } = await buildListAsset(payload);

      // 2. User signs with Freighter.
      setStatus("signing");
      const signedXdr = await signWithFreighter(xdr, networkPassphrase, owner);

      // 3. Backend submits and returns the new on-chain asset id.
      setStatus("submitting");
      const { id } = await submitListAsset({ ...payload, signedXdr });

      // 4. Redirect to the new asset's detail page.
      setStatus("success");
      if (id != null) {
        router.push(`/marketplace/${id}`);
      } else {
        router.push("/marketplace");
      }
    } catch (err) {
      setStatus("idle");
      if (err instanceof FreighterError || err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError(
          err instanceof Error ? err.message : "Something went wrong. Please try again."
        );
      }
    }
  }

  return (
    <main className="flex min-h-screen justify-center bg-black px-4 py-12 text-white sm:py-16">
      <div className="w-full max-w-xl space-y-6">
        <a
          href="/marketplace"
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <span aria-hidden>←</span> Back to marketplace
        </a>

        <div className="space-y-2">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-purple-400">
            List Asset
          </p>
          <h1 className="text-3xl font-bold tracking-tight">
            List a new intelligence asset
          </h1>
          <p className="text-sm text-zinc-400">
            Publish an asset to the Cortex marketplace on Stellar{" "}
            <span className="font-medium text-zinc-300">{TARGET_NETWORK_LABEL}</span>. You&apos;ll
            sign the listing with your Freighter wallet.
          </p>
        </div>

        {/* Wallet connection */}
        <WalletPanel
          wallet={wallet}
          connecting={connecting}
          onCorrectNetwork={onCorrectNetwork}
          walletError={walletError}
          onConnect={handleConnect}
        />

        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-red-900/70 bg-red-950/50 px-4 py-3 text-sm text-red-300"
          >
            <span aria-hidden className="mt-0.5 shrink-0">
              ⚠
            </span>
            <span>{formError}</span>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 shadow-2xl shadow-black/40 sm:p-8"
        >
          {/* Name */}
          <Field label="Name" htmlFor="name" error={errors.name}>
            <input
              id="name"
              type="text"
              value={form.name}
              maxLength={NAME_MAX}
              onChange={(e) => update("name", e.target.value)}
              disabled={busy}
              placeholder="Chain-of-Thought Reasoning Prompt"
              className={inputClass(!!errors.name)}
            />
            <CharCount value={form.name} max={NAME_MAX} />
          </Field>

          {/* Description */}
          <Field label="Description" htmlFor="description" error={errors.description}>
            <textarea
              id="description"
              value={form.description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => update("description", e.target.value)}
              disabled={busy}
              rows={5}
              placeholder="Describe what this asset does and when to use it."
              className={inputClass(!!errors.description)}
            />
            <CharCount value={form.description} max={DESCRIPTION_MAX} />
          </Field>

          {/* Asset type */}
          <Field label="Asset type" htmlFor="assetType" error={errors.assetType}>
            <select
              id="assetType"
              value={form.assetType}
              onChange={(e) => update("assetType", e.target.value)}
              disabled={busy}
              className={inputClass(!!errors.assetType)}
            >
              <option value="">Select an asset type…</option>
              {ASSET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ASSET_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>

          {/* License type */}
          <Field label="License type" htmlFor="licenseType" error={errors.licenseType}>
            <select
              id="licenseType"
              value={form.licenseType}
              onChange={(e) => update("licenseType", e.target.value)}
              disabled={busy}
              className={inputClass(!!errors.licenseType)}
            >
              <option value="">Select a license type…</option>
              {LICENSE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LICENSE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>

          {/* Price */}
          <Field label="Price" htmlFor="price" error={errors.priceXlm}>
            <div className="relative">
              <input
                id="price"
                type="text"
                inputMode="decimal"
                value={form.priceXlm}
                onChange={(e) => update("priceXlm", e.target.value)}
                disabled={busy}
                placeholder="0.5"
                className={`${inputClass(!!errors.priceXlm)} pr-14`}
              />
              <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm font-medium text-zinc-500">
                XLM
              </span>
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              {priceStroops !== undefined
                ? `= ${priceStroops.toString()} stroops · ${stroopsToXlm(priceStroops)} XLM`
                : "1 XLM = 10,000,000 stroops · up to 7 decimal places"}
            </p>
          </Field>

          <div className="space-y-3 pt-2">
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-6 py-3 font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy && (
                <span
                  aria-hidden
                  className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black"
                />
              )}
              {busy
                ? STATUS_LABELS[status]
                : !wallet
                  ? "Connect wallet to list"
                  : !onCorrectNetwork
                    ? `Switch Freighter to ${TARGET_NETWORK_LABEL}`
                    : "List asset"}
            </button>

            <p className="text-center text-xs text-zinc-600">
              You&apos;ll be asked to approve the transaction in Freighter. Network fees apply.
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}

// ── Presentational helpers ────────────────────────────────────────────────────

function WalletPanel({
  wallet,
  connecting,
  onCorrectNetwork,
  walletError,
  onConnect,
}: {
  wallet: WalletConnection | null;
  connecting: boolean;
  onCorrectNetwork: boolean;
  walletError: string | null;
  onConnect: () => void;
}) {
  if (!wallet) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-purple-500/40 bg-purple-500/10 px-4 py-3 text-sm font-semibold text-purple-200 transition-colors hover:bg-purple-500/20 disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect Freighter wallet"}
        </button>
        {walletError && (
          <p role="alert" className="text-sm text-red-400">
            {walletError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${
              onCorrectNetwork ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          <span className="font-mono text-zinc-300">
            {truncateAddress(wallet.address)}
          </span>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            onCorrectNetwork
              ? "bg-emerald-500/10 text-emerald-300"
              : "bg-amber-500/10 text-amber-300"
          }`}
        >
          {networkLabel(wallet.network)}
        </span>
      </div>
      {!onCorrectNetwork && (
        <p role="alert" className="text-sm text-amber-400">
          Freighter is on {networkLabel(wallet.network)}. Switch it to{" "}
          {TARGET_NETWORK_LABEL} to list an asset — this page updates automatically.
        </p>
      )}
      {walletError && (
        <p role="alert" className="text-sm text-red-400">
          {walletError}
        </p>
      )}
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return [
    "w-full rounded-lg border bg-zinc-900/80 px-4 py-2.5 text-white placeholder:text-zinc-600",
    "transition-colors focus:outline-none focus:ring-2 disabled:opacity-60",
    hasError
      ? "border-red-700 focus:ring-red-500/50"
      : "border-zinc-800 focus:border-purple-500/60 focus:ring-purple-500/40",
  ].join(" ");
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-300">
        {label}
      </label>
      {children}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <p className="mt-1 text-right text-xs text-zinc-600">
      {value.trim().length}/{max}
    </p>
  );
}
