import { redirect } from "next/navigation";

// Settings are now handled via modals in the main dashboard.
// This route redirects to avoid dead links.
export default function SettingsPage() {
  redirect("/");
}