export interface QueueProduct {
  id: string;
  ebayItemId: string;
  title: string;
  images: string[];

  // Pricing — reference listing (Chinese seller on eBay)
  ebayReferencePrice:    number;  // raw listing price of the reference item
  ebayShippingCost:      number;  // what reference seller charges for shipping (0 = free)
  totalMarketCost:       number;  // ebayReferencePrice + ebayShippingCost = true buyer cost

  // Pricing — our listing (FREE shipping)
  suggestedSellingPrice: number;  // recommended price for our listing (3% below totalMarketCost)

  // Eprolo sourcing (filled after Eprolo lookup)
  eproloPrice:           number | null;
  eproloUrl:             string | null;

  // Profit (filled once eproloPrice is known)
  margin:                number | null;  // suggestedSellingPrice - eproloPrice - eproloShipping - eBayFees
  marginPercent:         number | null;

  // Categorization
  categoryId:   string;
  categoryName: string;

  // Sales intelligence
  soldCount:        number;  // total sold on reference listing (all time, current period)
  estimatedSold30d: number;  // estimated sales in last 30 days (velocity * decay factor)
  listingAgeDays:   number;  // age of reference listing in days

  // Listing metadata
  condition:   string;
  sourceUrl:   string;
  status:      "pending" | "approved" | "rejected" | "published";
  description: string;
  stock:       number;

  // eBay listing IDs (filled after publishing)
  listingId?: string;
  offerId?:   string;
  sku?:       string;

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