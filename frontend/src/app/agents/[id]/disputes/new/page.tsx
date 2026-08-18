"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fileDispute, submitEvidence } from "@/lib/reputation";

interface EvidenceBundle {
  claim: string;
  detail: string;
  transactions: string[];
  attachments: Array<{ name: string; size: number; content: string }>;
}

/**
 * Dispute filing form.
 *
 * The evidence bundle stays off-chain: it is uploaded here, the backend hashes
 * it, and the returned digest is what the filer passes to `open_dispute` as
 * `evidence_hash`. The form therefore ends by showing that digest to copy.
 */
export default function NewDisputePage() {
  const params = useParams();
  const agentId = params.id as string;

  const [disputeId, setDisputeId] = useState("");
  const [complainant, setComplainant] = useState("");
  const [respondent, setRespondent] = useState("");
  const [claim, setClaim] = useState("");
  const [detail, setDetail] = useState("");
  const [transactions, setTransactions] = useState("");
  const [attachments, setAttachments] = useState<EvidenceBundle["attachments"]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceHash, setEvidenceHash] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    const read = await Promise.all(
      Array.from(files).map(
        (file) =>
          new Promise<EvidenceBundle["attachments"][number]>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: file.name,
                size: file.size,
                content: String(reader.result ?? ""),
              });
            reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
            reader.readAsText(file);
          })
      )
    ).catch((err: Error) => {
      setError(err.message);
      return [] as EvidenceBundle["attachments"];
    });

    setAttachments((current) => [...current, ...read]);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setEvidenceHash(null);

    if (!claim.trim()) {
      setError("Describe what went wrong before filing.");
      return;
    }

    const evidence: EvidenceBundle = {
      claim: claim.trim(),
      detail: detail.trim(),
      transactions: transactions
        .split(/[\s,]+/)
        .map((tx) => tx.trim())
        .filter(Boolean),
      attachments,
    };

    setSubmitting(true);
    try {
      const result = await fileDispute({
        id: Number(disputeId),
        complainant: complainant.trim(),
        respondent: respondent.trim(),
        evidence,
      });

      if (!result.ok || !result.dispute) {
        setError(result.error ?? "Could not file the dispute.");
        return;
      }

      // Re-upload through the evidence endpoint so the response carries the
      // digest to commit on-chain.
      const stored = await submitEvidence(result.dispute.id, evidence);
      if (!stored.ok) {
        setError(stored.error ?? "The dispute was filed but the evidence was rejected.");
        return;
      }

      setEvidenceHash(stored.evidenceHash ?? result.dispute.evidenceHash);
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-sm";

  return (
    <main className="min-h-screen bg-white dark:bg-black text-black dark:text-white pt-20 px-6">
      <div className="mx-auto max-w-2xl">
        <Link
          href={`/agents/${agentId}`}
          className="text-sm text-zinc-500 dark:text-zinc-400 hover:underline"
        >
          ← Back to agent
        </Link>

        <h1 className="mt-4 text-2xl font-semibold">File a dispute</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Open the dispute on-chain first, then record it here with your evidence. The digest
          returned below is the <code className="font-mono">evidence_hash</code> the contract
          commits to — anyone can re-hash the bundle and check it matches.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4" data-testid="dispute-form">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              On-chain dispute id
              <input
                type="number"
                min={1}
                required
                value={disputeId}
                onChange={(e) => setDisputeId(e.target.value)}
                className={inputClass}
                placeholder="returned by open_dispute"
              />
            </label>

            <label className="block text-sm">
              Your address (complainant)
              <input
                type="text"
                required
                value={complainant}
                onChange={(e) => setComplainant(e.target.value)}
                className={`${inputClass} font-mono`}
                placeholder="G…"
              />
            </label>
          </div>

          <label className="block text-sm">
            Respondent address
            <input
              type="text"
              required
              value={respondent}
              onChange={(e) => setRespondent(e.target.value)}
              className={`${inputClass} font-mono`}
              placeholder="G…"
            />
          </label>

          <label className="block text-sm">
            What went wrong?
            <input
              type="text"
              required
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              className={inputClass}
              placeholder="e.g. paid for an inference run that never completed"
            />
          </label>

          <label className="block text-sm">
            Detail
            <textarea
              rows={4}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              className={inputClass}
              placeholder="Timeline, what was agreed, what happened instead…"
            />
          </label>

          <label className="block text-sm">
            Related transaction hashes
            <input
              type="text"
              value={transactions}
              onChange={(e) => setTransactions(e.target.value)}
              className={`${inputClass} font-mono`}
              placeholder="comma or space separated"
            />
          </label>

          <label className="block text-sm">
            Attachments
            <input
              type="file"
              multiple
              accept=".txt,.json,.log,.md"
              onChange={(e) => void handleFiles(e.target.files)}
              className="mt-1 block w-full text-sm"
            />
          </label>

          {attachments.length > 0 && (
            <ul className="text-xs text-zinc-500 dark:text-zinc-400">
              {attachments.map((file) => (
                <li key={file.name}>
                  {file.name} ({file.size} bytes)
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-black dark:bg-white px-4 py-2 text-sm font-medium text-white dark:text-black disabled:opacity-60"
          >
            {submitting ? "Filing…" : "File dispute"}
          </button>
        </form>

        {evidenceHash && (
          <div
            data-testid="evidence-hash"
            className="mt-6 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-4"
          >
            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
              Evidence stored. Commit this digest on-chain:
            </p>
            <code className="mt-2 block break-all font-mono text-xs">{evidenceHash}</code>
          </div>
        )}
      </div>
    </main>
  );
}
