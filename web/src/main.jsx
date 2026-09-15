import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import AuthGate from "./AuthGate";
import ProductManager from "./ProductManager";

// Service worker: caches the app shell so it opens with no signal (walk-in, freezer).
// autoUpdate installs a new build in the background; we reload only when nothing is
// in flight, so a fresh deploy can't yank the page out from under someone counting.
registerSW({
  immediate: true,
  onNeedRefresh() {
    try {
      const drafts = JSON.parse(localStorage.getItem("lvmgp_count_drafts") || "{}");
      const pending = JSON.parse(localStorage.getItem("lvmgp_pending_counts") || "[]");
      if (!Object.keys(drafts).length && !pending.length) window.location.reload();
    } catch { /* leave the old version running rather than risk losing a count */ }
  },
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <ProductManager />
    </AuthGate>
  </React.StrictMode>,
);
