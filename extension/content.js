// content.js — runs on 1688 product pages
// Adds a floating "Import to DropFlow" button on product detail pages

(function () {
  // Only run on product detail pages
  if (!window.location.href.includes("/offer/") && !window.location.href.includes("detail.1688.com")) return;
  if (document.getElementById("dropflow-btn")) return; // already injected

  // Create floating button
  const btn = document.createElement("div");
  btn.id = "dropflow-btn";
  btn.innerHTML = `
    <div id="dropflow-fab" style="
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    ">
      <div id="dropflow-toast" style="
        display: none;
        background: #10b981;
        color: #fff;
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        animation: dfSlideIn 0.2s ease;
      ">✅ Added to DropFlow!</div>

      <button id="dropflow-main-btn" style="
        display: flex;
        align-items: center;
        gap: 8px;
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        color: #fff;
        border: none;
        border-radius: 12px;
        padding: 12px 18px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 4px 24px rgba(59,130,246,0.5);
        transition: transform 0.15s, box-shadow 0.15s;
        letter-spacing: 0.01em;
      ">
        <span style="font-size:18px;">⚡</span>
        Import to DropFlow
      </button>
    </div>
    <style>
      @keyframes dfSlideIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #dropflow-main-btn:hover {
        transform: translateY(-2px) !important;
        box-shadow: 0 8px 30px rgba(59,130,246,0.6) !important;
      }
      #dropflow-main-btn:active { transform: scale(0.97) !important; }
      #dropflow-main-btn:disabled {
        background: linear-gradient(135deg, #4b5563, #374151) !important;
        cursor: not-allowed !important;
        box-shadow: none !important;
      }
    </style>
  `;

  document.body.appendChild(btn);

  // Open popup when button clicked
  document.getElementById("dropflow-main-btn").addEventListener("click", () => {
    // The popup will handle everything — just open it
    // Content script can't directly open popup, but we can send a message
    chrome.runtime.sendMessage({ action: "openPopup" });
  });

})();