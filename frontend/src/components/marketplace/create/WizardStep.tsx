"use client";

interface WizardStepProps {
  step: number;
  totalSteps: number;
  title: string;
  description: string;
  children: React.ReactNode;
  onNext: () => void;
  onBack: () => void;
  isLastStep: boolean;
  canProceed: boolean;
}

export function WizardStep({
  step,
  totalSteps,
  title,
  description,
  children,
  onNext,
  onBack,
  isLastStep,
  canProceed,
}: WizardStepProps) {
  return (
    <div className="space-y-6">
      {/* Progress Bar */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-2xl font-bold">{title}</h2>
          <span className="text-sm text-zinc-500">
            Step {step} of {totalSteps}
          </span>
        </div>
        <p className="text-zinc-400 mb-4">{description}</p>

        {/* Progress indicator */}
        <div className="flex gap-1">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`flex-1 h-1 rounded-full transition-colors ${
                i < step
                  ? "bg-purple-500"
                  : i === step - 1
                    ? "bg-purple-400"
                    : "bg-zinc-800"
              }`}
            />
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8">
        {children}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          disabled={step === 1}
          className="px-4 py-2 text-sm border border-zinc-700 text-zinc-300 rounded-lg hover:border-zinc-500 disabled:opacity-50 transition-colors"
        >
          ← Back
        </button>

        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-400">
            {isLastStep ? "Ready to publish?" : "Continue to next step"}
          </span>
          <button
            onClick={onNext}
            disabled={!canProceed}
            className="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold disabled:opacity-50 transition-colors"
          >
            {isLastStep ? "Publish Asset" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}
