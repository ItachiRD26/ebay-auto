import { db, COLLECTIONS } from "@/lib/firebase";
import { QueueProduct } from "@/types";

export async function addToQueue(product: Omit<QueueProduct, "id">): Promise<string> {
  const ref = db.collection(COLLECTIONS.QUEUE).doc();
  await ref.set(product);
  return ref.id;
}

export async function updateQueueProduct(
  productId: string,
  updates: Partial<QueueProduct>
): Promise<void> {
  await db
    .collection(COLLECTIONS.QUEUE)
    .doc(productId)
    .update({ ...updates, updatedAt: Date.now() });
}

export async function getQueueProduct(productId: string): Promise<QueueProduct | null> {
  const doc = await db.collection(COLLECTIONS.QUEUE).doc(productId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as QueueProduct;
}

export async function isAlreadyInQueue(ebayItemId: string): Promise<boolean> {
  const snap = await db
    .collection(COLLECTIONS.QUEUE)
    .where("ebayItemId", "==", ebayItemId)
    .limit(1)
    .get();
  return !snap.empty;
}