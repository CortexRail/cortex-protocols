"use client";

import { useState } from "react";
import Link from "next/link";
import { AssetType, LicenseType } from "@/lib/api/assets";
import { WizardStep } from "@/components/marketplace/create/WizardStep";

interface AssetForm {
  name: string;
  description: string;
  type: AssetType | "";
  licenseType: LicenseType | "";
  priceInStroops: number;
  tags: string[];
}

const ASSET_TYPES: AssetType[] = ["prompt", "workflow", "reasoning", "agent", "dataset", "model", "integration", "template"];
const LICENSE_TYPES: LicenseType[] = ["CC0", "MIT", "Apache2", "Custom"];

export default function CreateAssetPage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<AssetForm>({
    name: "",
    description: "",
    type: "",
    licenseType: "",
    priceInStroops: 0,
    tags: [],
  });
  const [tagInput, setTagInput] = useState("");

  const updateForm = <K extends keyof AssetForm>(field: K, value: AssetForm[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const addTag = () => {
    if (tagInput.trim() && !form.tags.includes(tagInput.trim())) {
      setForm((prev) => ({
        ...prev,
        tags: [...prev.tags, tagInput.trim()],
      }));
      setTagInput("");
    }
  };

  const removeTag = (tag: string) => {
    setForm((prev) => ({
      ...prev,
      tags: prev.tags.filter((t) => t !== tag),
    }));
  };

  const canProceedStep1 = form.name && form.description;
  const canProceedStep2 = form.type && form.licenseType && form.priceInStroops > 0;
  const canProceedStep3 = true;
  const canProceedStep4 = canProceedStep1 && canProceedStep2;

  const handlePublish = async () => {
    if (!canProceedStep4) return;

    try {
      const response = await fetch("http://localhost:4000/api/v1/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          type: form.type,
          licenseType: form.licenseType,
          priceInStroops: form.priceInStroops,
          tags: form.tags,
        }),
      });

      if (!response.ok) throw new Error("Failed to create asset");
      const data = await response.json();
      window.location.href = `/marketplace/${data.id}`;
    } catch {
      alert("Failed to publish asset. Please try again.");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold mb-2">Create Asset</h1>
            <p className="text-zinc-400">
              Publish your intelligence asset and start earning from Stellar micropayments
            </p>
          </div>
          <Link
            href="/marketplace"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            ✕
          </Link>
        </div>

        {/* Step 1: Basic Info */}
        {step === 1 && (
          <WizardStep
            step={1}
            totalSteps={4}
            title="Basic Information"
            description="Tell us about your asset"
            canProceed={canProceedStep1}
            onNext={() => setStep(2)}
            onBack={() => setStep(0)}
            isLastStep={false}
          >
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold mb-2">Asset Name *</label>
                <input
                  type="text"
                  placeholder="e.g., Advanced Reasoning Prompt"
                  value={form.name}
                  onChange={(e) => updateForm("name", e.target.value)}
                  className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Description *</label>
                <textarea
                  placeholder="Describe your asset, its use cases, and benefits..."
                  value={form.description}
                  onChange={(e) => updateForm("description", e.target.value)}
                  rows={6}
                  className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 resize-none"
                />
              </div>
            </div>
          </WizardStep>
        )}

        {/* Step 2: Licensing */}
        {step === 2 && (
          <WizardStep
            step={2}
            totalSteps={4}
            title="License & Pricing"
            description="Set the license type and price"
            canProceed={canProceedStep2}
            onNext={() => setStep(3)}
            onBack={() => setStep(1)}
            isLastStep={false}
          >
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold mb-3">Asset Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  {ASSET_TYPES.map((type) => (
                    <button
                      key={type}
                      onClick={() => updateForm("type", type)}
                      className={`px-4 py-3 rounded-lg text-left transition-colors ${
                        form.type === type
                          ? "bg-purple-600 text-white border-purple-600"
                          : "bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-3">License Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  {LICENSE_TYPES.map((license) => (
                    <button
                      key={license}
                      onClick={() => updateForm("licenseType", license)}
                      className={`px-4 py-3 rounded-lg text-left transition-colors ${
                        form.licenseType === license
                          ? "bg-purple-600 text-white border-purple-600"
                          : "bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      {license}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Price (XLM) *</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="0.00"
                    value={form.priceInStroops / 10_000_000}
                    onChange={(e) =>
                      updateForm(
                        "priceInStroops",
                        Number(e.target.value) * 10_000_000
                      )
                    }
                    className="flex-1 px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
                  />
                  <span className="px-4 py-2 bg-zinc-800 text-zinc-400 rounded-lg">
                    XLM
                  </span>
                </div>
              </div>
            </div>
          </WizardStep>
        )}

        {/* Step 3: Tags */}
        {step === 3 && (
          <WizardStep
            step={3}
            totalSteps={4}
            title="Tags"
            description="Add tags to help users discover your asset"
            canProceed={canProceedStep3}
            onNext={() => setStep(4)}
            onBack={() => setStep(2)}
            isLastStep={false}
          >
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Add a tag..."
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  className="flex-1 px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
                />
                <button
                  onClick={addTag}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
                >
                  Add
                </button>
              </div>

              {form.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {form.tags.map((tag) => (
                    <div
                      key={tag}
                      className="flex items-center gap-2 px-3 py-1 bg-zinc-800 rounded-full text-sm"
                    >
                      <span>{tag}</span>
                      <button
                        onClick={() => removeTag(tag)}
                        className="text-zinc-500 hover:text-zinc-300"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </WizardStep>
        )}

        {/* Step 4: Review */}
        {step === 4 && (
          <WizardStep
            step={4}
            totalSteps={4}
            title="Review & Publish"
            description="Review your asset details before publishing"
            canProceed={canProceedStep4}
            onNext={handlePublish}
            onBack={() => setStep(3)}
            isLastStep={true}
          >
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Name</p>
                  <p className="font-semibold">{form.name}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Type</p>
                  <p className="font-semibold">{form.type}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">License</p>
                  <p className="font-semibold">{form.licenseType}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Price</p>
                  <p className="font-semibold">
                    {(form.priceInStroops / 10_000_000).toFixed(2)} XLM
                  </p>
                </div>
              </div>

              <div>
                <p className="text-xs text-zinc-500 mb-2">Description</p>
                <p className="text-zinc-300 whitespace-pre-wrap">
                  {form.description}
                </p>
              </div>

              {form.tags.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 mb-2">Tags</p>
                  <div className="flex flex-wrap gap-2">
                    {form.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-3 py-1 bg-zinc-800 text-zinc-300 rounded-full text-sm"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="p-4 bg-blue-500/10 border border-blue-500 rounded-lg text-blue-300 text-sm">
                You will be asked to sign this transaction with your Freighter wallet.
              </div>
            </div>
          </WizardStep>
        )}

        {/* Back link */}
        {step === 1 && (
          <Link
            href="/marketplace"
            className="inline-block mt-8 text-zinc-400 hover:text-white transition-colors"
          >
            ← Back to Marketplace
          </Link>
        )}
      </div>
    </main>
  );
}
