"use client";

import { useState } from "react";
import Link from "next/link";

const CAPABILITIES = [
  { id: "TextGeneration", label: "Text Generation", desc: "Generate human-like text responses" },
  { id: "CodeGeneration", label: "Code Generation", desc: "Write and optimize code" },
  { id: "Reasoning", label: "Reasoning", desc: "Complex logical reasoning" },
  { id: "VisionUnderstanding", label: "Vision Understanding", desc: "Process and analyze images" },
  { id: "AudioProcessing", label: "Audio Processing", desc: "Handle audio files and speech" },
  { id: "DataAnalysis", label: "Data Analysis", desc: "Analyze and visualize data" },
  { id: "WebResearch", label: "Web Research", desc: "Search and retrieve web information" },
  { id: "ActionExecution", label: "Action Execution", desc: "Execute external actions" },
];

type Step = 1 | 2 | 3 | 4;

interface RegistrationForm {
  name: string;
  description: string;
  capabilities: string[];
}

export default function RegisterAgentPage() {
  const [step, setStep] = useState<Step>(1);
  const [formData, setFormData] = useState<RegistrationForm>({
    name: "",
    description: "",
    capabilities: [],
  });

  const updateForm = <Field extends keyof RegistrationForm>(
    field: Field,
    value: RegistrationForm[Field]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const toggleCapability = (capId: string) => {
    setFormData((prev) => ({
      ...prev,
      capabilities: prev.capabilities.includes(capId)
        ? prev.capabilities.filter((c) => c !== capId)
        : [...prev.capabilities, capId],
    }));
  };

  const canProceed = () => {
    if (step === 1) return formData.name.length > 0 && formData.description.length > 0;
    if (step === 2) return formData.capabilities.length > 0;
    return true;
  };

  const handleSubmit = async () => {
    try {
      const res = await fetch("http://localhost:4000/api/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: Math.floor(Math.random() * 10000) + 1,
          owner: "G" + "X".repeat(55), // Placeholder, should be from wallet
          ...formData,
        }),
      });

      if (res.ok) {
        alert("Agent registered successfully!");
        // Redirect to agents page
        window.location.href = "/agents";
      } else {
        alert("Registration failed");
      }
    } catch (err) {
      console.error("Registration error:", err);
      alert("An error occurred");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <Link
            href="/agents"
            className="text-zinc-400 hover:text-white mb-6 inline-block text-sm"
          >
            ← Back to Directory
          </Link>
          <h1 className="text-3xl font-bold mb-2">Register Your Agent</h1>
          <p className="text-zinc-400">Join the Intelligence Rail marketplace</p>
        </div>

        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex justify-between mb-4">
            {[1, 2, 3, 4].map((s) => (
              <div key={s} className="text-center flex-1">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-2 font-semibold ${
                    step >= s
                      ? "bg-purple-600 text-white"
                      : "bg-zinc-800 text-zinc-500"
                  }`}
                >
                  {s}
                </div>
                <p className="text-xs text-zinc-500">
                  {["Identity", "Capabilities", "Preview", "Sign"][s - 1]}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8">
          {/* Step 1: Identity */}
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold mb-2">Agent Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => updateForm("name", e.target.value)}
                  placeholder="e.g., CodeWeaver v2"
                  className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2">Description *</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => updateForm("description", e.target.value)}
                  placeholder="Describe your agent's purpose, specialization, and unique value..."
                  rows={4}
                  className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
          )}

          {/* Step 2: Capabilities */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400 mb-6">Select all capabilities this agent has *</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {CAPABILITIES.map((cap) => (
                  <label
                    key={cap.id}
                    className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                      formData.capabilities.includes(cap.id)
                        ? "border-purple-500 bg-purple-500/10"
                        : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={formData.capabilities.includes(cap.id)}
                        onChange={() => toggleCapability(cap.id)}
                        className="w-5 h-5 cursor-pointer"
                      />
                      <div>
                        <p className="font-semibold text-sm">{cap.label}</p>
                        <p className="text-xs text-zinc-500">{cap.desc}</p>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Preview */}
          {step === 3 && (
            <div className="space-y-6">
              <div className="p-6 bg-zinc-800 border border-zinc-700 rounded-lg">
                <h3 className="font-semibold mb-4">Agent Card Preview</h3>
                <div>
                  <p className="text-lg font-bold mb-2">{formData.name || "Unnamed Agent"}</p>
                  <p className="text-sm text-zinc-300 mb-4">
                    {formData.description || "No description provided"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {formData.capabilities.length > 0 ? (
                      formData.capabilities.map((cap) => (
                        <span
                          key={cap}
                          className="px-2 py-1 text-xs bg-purple-500/20 text-purple-300 rounded"
                        >
                          {cap}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-zinc-500">No capabilities selected</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="p-6 bg-zinc-800 border border-zinc-700 rounded-lg">
                <h3 className="font-semibold mb-4">Profile Information</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-zinc-400">Name:</dt>
                    <dd className="font-semibold">{formData.name}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-zinc-400">Capabilities:</dt>
                    <dd className="font-semibold">{formData.capabilities.length}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          {/* Step 4: Sign */}
          {step === 4 && (
            <div className="space-y-6 text-center">
              <div className="p-6 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                <h3 className="font-semibold mb-2">Ready to Register</h3>
                <p className="text-sm text-zinc-300 mb-4">
                  You&apos;ll be asked to sign the transaction with your Freighter wallet.
                </p>
              </div>

              <div className="space-y-3 text-left text-sm">
                <p className="text-zinc-400 mb-4">Registration will:</p>
                <ul className="space-y-2 text-zinc-300">
                  <li>✓ Register your agent on-chain</li>
                  <li>✓ Set your capabilities and reputation to 50%</li>
                  <li>✓ Make your agent discoverable</li>
                  <li>✓ Allow you to list assets</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between gap-4 mt-8">
          <button
            onClick={() => setStep(Math.max(1, step - 1) as Step)}
            disabled={step === 1}
            className="px-6 py-2 border border-zinc-700 rounded-lg hover:border-zinc-600 disabled:opacity-50 font-semibold transition-colors"
          >
            Previous
          </button>

          {step === 4 ? (
            <button
              onClick={handleSubmit}
              className="px-6 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
            >
              Sign & Register
            </button>
          ) : (
            <button
              onClick={() => setStep(Math.min(4, step + 1) as Step)}
              disabled={!canProceed()}
              className="px-6 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
