import { render, screen } from "@testing-library/react";
import { AssetCard } from "@/components/marketplace/AssetCard";
import { AssetGrid } from "@/components/marketplace/AssetGrid";
import { Asset } from "@/lib/api/assets";

const mockAsset: Asset = {
  id: "test-1",
  name: "Test Prompt",
  description: "A test intelligence asset for the marketplace",
  type: "prompt",
  licenseType: "MIT",
  priceInStroops: 1_000_000,
  owner: {
    id: "owner-1",
    name: "Test Owner",
    reputation: 85,
  },
  usageCount: 1250,
  tags: ["ai", "reasoning"],
  createdAt: Date.now(),
};

describe("Marketplace Components", () => {
  describe("AssetCard", () => {
    it("renders asset information correctly", () => {
      render(<AssetCard asset={mockAsset} />);

      expect(screen.getByText("Test Prompt")).toBeInTheDocument();
      expect(screen.getByText(/A test intelligence asset/)).toBeInTheDocument();
      expect(screen.getByText("Test Owner")).toBeInTheDocument();
    });

    it("displays asset type and license badges", () => {
      render(<AssetCard asset={mockAsset} />);

      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(screen.getByText("MIT")).toBeInTheDocument();
    });

    it("shows owner reputation", () => {
      render(<AssetCard asset={mockAsset} />);

      expect(screen.getByText("85%")).toBeInTheDocument();
    });
  });

  describe("AssetGrid", () => {
    it("renders loading skeletons when loading", () => {
      const { container } = render(
        <AssetGrid assets={[]} isLoading={true} />
      );

      const skeletons = container.querySelectorAll(".animate-pulse");
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it("renders empty state when no assets", () => {
      render(<AssetGrid assets={[]} isLoading={false} />);

      expect(screen.getByText("No assets found")).toBeInTheDocument();
    });

    it("renders asset cards for each asset", () => {
      const assets = [
        mockAsset,
        { ...mockAsset, id: "test-2", name: "Another Asset" },
      ];
      render(<AssetGrid assets={assets} isLoading={false} />);

      expect(screen.getByText("Test Prompt")).toBeInTheDocument();
      expect(screen.getByText("Another Asset")).toBeInTheDocument();
    });
  });
});
