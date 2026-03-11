import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

export const db = getFirestore();

export const COLLECTIONS = {
  QUEUE: "products_queue",
  PUBLISHED: "published",
  SETTINGS: "settings",
  LOGS: "logs",
};

export const DEFAULT_SETTINGS = {
  // Pricing filters
  minPrice: 15,
  maxPrice: 80,
  markupPercent: 40,
  // Sales filter
  minSoldCount: 20,
  // Margin
  minMarginPercent: 30,
  // Listing
  defaultStock: 10,
  ebayMarketplace: "EBAY_US",
  // Search
  autoSearchEnabled: false,
  searchIntervalMinutes: 60,
  searchKeywords: [],
  // Extra filters
  onlyFreeShipping: false,
  onlyNewCondition: true,
};