import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";

// ─── Secret to prevent unauthorized calls ────────────────────────────────────
const CRON_SECRET = process.env.CRON_SECRET ?? "";

// ─── Config ───────────────────────────────────────────────────────────────────
const SEEN_TTL_DAYS        = 5;   // Delete seen_items older than 90 days
const STALE_APPROVED_DAYS  = 5;   // Delete approved products not published in 30 days
const STALE_REJECTED_DAYS  = 5;    // Delete rejected products older than 7 days (backup)
const BATCH_LIMIT          = 400;  // Firestore batch max is 500

export async function POST(req: NextRequest) {
  // Verify secret header from Cloud Scheduler
  const secret = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now      = Date.now();
  const results  = { seenDeleted: 0, queueDeleted: 0, usersProcessed: 0, errors: [] as string[] };

  try {
    // Get all user IDs from the users collection
    const usersSnap = await db.collection("users").listDocuments();
    results.usersProcessed = usersSnap.length;

    for (const userRef of usersSnap) {
      const userId = userRef.id;
      try {
        // ── 1. Clean seen_items older than TTL ─────────────────────────────────
        const seenCutoff = now - SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
        const oldSeen = await db
          .collection("users").doc(userId).collection("seen_items")
          .where("seenAt", "<", seenCutoff)
          .limit(BATCH_LIMIT)
          .get();

        if (!oldSeen.empty) {
          const batch = db.batch();
          oldSeen.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
          results.seenDeleted += oldSeen.size;
          console.log(`[cleanup] ${userId}: deleted ${oldSeen.size} old seen_items`);
        }

        // ── 2. Clean stale approved products (never published) ─────────────────
        const approvedCutoff = now - STALE_APPROVED_DAYS * 24 * 60 * 60 * 1000;
        const staleApproved = await db
          .collection("users").doc(userId).collection("products_queue")
          .where("status", "==", "approved")
          .where("createdAt", "<", approvedCutoff)
          .limit(BATCH_LIMIT)
          .get();

        if (!staleApproved.empty) {
          const batch = db.batch();
          // Before deleting, write each to seen_items so it won't re-appear
          const seenBatch = db.batch();
          for (const doc of staleApproved.docs) {
            const p = doc.data() as Record<string, unknown>;
            const rawId = String(p.ebayItemId ?? "");
            const ebayItemId = rawId.split("|")[1] ?? rawId;
            if (ebayItemId) {
              seenBatch.set(
                db.collection("users").doc(userId).collection("seen_items").doc(ebayItemId),
                { ebayItemId, title: p.title ?? "", reason: "expired_approved", seenAt: now, productId: doc.id },
                { merge: true }
              );
            }
            batch.delete(doc.ref);
          }
          await seenBatch.commit();
          await batch.commit();
          results.queueDeleted += staleApproved.size;
          console.log(`[cleanup] ${userId}: deleted ${staleApproved.size} stale approved products`);
        }

        // ── 3. Clean old rejected products (backup — queue route already deletes them) ──
        const rejectedCutoff = now - STALE_REJECTED_DAYS * 24 * 60 * 60 * 1000;
        const staleRejected = await db
          .collection("users").doc(userId).collection("products_queue")
          .where("status", "==", "rejected")
          .where("updatedAt", "<", rejectedCutoff)
          .limit(BATCH_LIMIT)
          .get();

        if (!staleRejected.empty) {
          const batch = db.batch();
          staleRejected.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
          results.queueDeleted += staleRejected.size;
          console.log(`[cleanup] ${userId}: deleted ${staleRejected.size} old rejected products`);
        }

      } catch (userErr) {
        const msg = userErr instanceof Error ? userErr.message : String(userErr);
        results.errors.push(`${userId}: ${msg}`);
        console.error(`[cleanup] Error for user ${userId}:`, msg);
      }
    }

    console.log(`[cleanup] ✅ Done — seen: ${results.seenDeleted} deleted, queue: ${results.queueDeleted} deleted, users: ${results.usersProcessed}`);
    return NextResponse.json({ success: true, ...results });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cleanup] Fatal error:", msg);
    return NextResponse.json({ error: msg, ...results }, { status: 500 });
  }
}

// ── GET — health check ──────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get("secret") ?? "";
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    config: {
      seenTTL:       `${SEEN_TTL_DAYS} days`,
      staleApproved: `${STALE_APPROVED_DAYS} days`,
      staleRejected: `${STALE_REJECTED_DAYS} days`,
    },
  });
}