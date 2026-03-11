export interface QueueProduct {
  id: string;
  ebayItemId: string;
  title: string;
  images: string[];
  ebayReferencePrice: number;
  eproloPrice: number | null;
  eproloUrl: string | null;
  suggestedSellingPrice: number;
  margin: number | null;
  marginPercent: number | null;
  categoryId: string;
  categoryName: string;
  soldCount: number;
  condition: string;
  sourceUrl: string;
  status: "pending" | "approved" | "rejected" | "published";
  description: string;
  stock: number;
  listingId?: string;
  offerId?: string;
  sku?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  // Pricing
  minPrice: number;
  maxPrice: number;
  markupPercent: number;
  // Sales
  minSoldCount: number;
  // Margin
  minMarginPercent: number;
  // Listing
  defaultStock: number;
  ebayMarketplace: string;
  // Search
  autoSearchEnabled: boolean;
  searchIntervalMinutes: number;
  searchKeywords: string[];
  // Filters
  onlyFreeShipping: boolean;
  onlyNewCondition: boolean;
}