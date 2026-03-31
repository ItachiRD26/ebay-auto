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

// ─── Subcollection helper ─────────────────────────────────────────────────────
// All user data lives under users/{userId}/* for isolation and security.
// tokens/{storeId} stays at root — keyed by storeId, not userId.
export const userCol = (userId: string, col: string) =>
  db.collection("users").doc(userId).collection(col);

// Convenience shorthands
export const queueCol    = (userId: string) => userCol(userId, "products_queue");
export const storesCol   = (userId: string) => userCol(userId, "stores");
export const settingsDoc = (userId: string, docId = "main") =>
  db.collection("users").doc(userId).collection("settings").doc(docId);

// Legacy flat-collection names kept for reference (no longer used for products)
export const COLLECTIONS = {
  QUEUE:    "products_queue",
  SETTINGS: "settings",
  LOGS:     "logs",
};

export const DEFAULT_SETTINGS = {
  minPrice: 15,
  maxPrice: 150,
  markupPercent: 6,
  minSoldCount: 5,
  minMarginPercent: 30,
  defaultStock: 1,
  ebayMarketplace: "EBAY_US",
  autoSearchEnabled: false,
  searchIntervalMinutes: 60,
  searchKeywords: [],
  onlyFreeShipping: false,
  onlyNewCondition: true,
};