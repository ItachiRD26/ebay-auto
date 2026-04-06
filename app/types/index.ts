export interface Store {
  id: string;
  name: string;           // User-defined nickname, e.g. "US Store"
  marketplace: string;    // "EBAY_US" | "EBAY_UK" | "EBAY_DE" | etc.
  connected: boolean;
  connectedAt?: number;
  ebayUsername?: string;  // Populated after successful OAuth
  createdAt: number;
  userId: string;         // Firebase Auth uid of the owner
}

export interface QueueProduct {
  id: string;
  ebayItemId: string;
  title: string;
  images: string[];

  // Ownership
  userId?: string;
  storeId?: string;

  // Pricing — reference listing (Chinese seller on eBay)
  ebayReferencePrice:    number;   // min variant price (used for filters)
  ebayShippingCost:      number;
  totalMarketCost:       number;
  refPriceMin:           number;   // lowest variant ref price  (for variation range display)
  refPriceMax:           number;   // highest variant ref price (for variation range display)

  // Pricing — our listing
  suggestedSellingPrice: number;   // kept for backwards compat (non-variation products)
  markupPercent:         number;   // 0-100 — applied to each variant's refPrice at publish time

  // Eprolo sourcing
  eproloPrice:           number | null;
  eproloUrl:             string | null;

  // Profit
  margin:                number | null;
  marginPercent:         number | null;

  // Categorization
  categoryId:   string;
  categoryName: string;

  // Sales intelligence
  soldCount:        number;
  estimatedSold30d: number;
  listingAgeDays:   number;

  // Listing metadata
  condition:   string;
  sourceUrl:   string;
  status:      "pending" | "approved" | "rejected" | "published" | "failed";
  failReason?:    string;
  normalizedTitle?: string;
  bidPercentage?: number;
  description: string;
  stock:       number;

  // eBay listing IDs (filled after publishing)
  listingId?: string;
  offerId?:   string;
  sku?:       string;

  createdAt: number;
  updatedAt: number;
  expiresAt?: Date;
}

export interface StorePolicy {
  fulfillmentPolicyId: string;
  paymentPolicyId:     string;
  returnPolicyId:      string;
  merchantLocationKey: string;
  itemCountry:         string;  // ISO code, e.g. "CN" — shown as item origin country
  itemLocation:        string;  // City string, e.g. "Shenzhen" — shown to buyer
}

export interface Settings {
  minPrice: number;
  maxPrice: number;
  markupPercent: number;
  minSoldCount: number;       // minimum total sales
  minSold30d: number;         // minimum estimated sales last 30 days (editable)
  maxVariations: number;      // max variations per product (default 12)
  minMarginPercent: number;
  defaultStock: number;
  ebayMarketplace: string;
  autoSearchEnabled: boolean;
  searchIntervalMinutes: number;
  searchKeywords: string[];
  onlyFreeShipping: boolean;
  onlyNewCondition: boolean;
  // Per-user eBay policies (override .env values)
  policies?: Record<string, StorePolicy>; // keyed by storeId
}