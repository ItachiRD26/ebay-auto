"use client";

export default function PrivacyPage() {
  const lastUpdated = "March 31, 2026";
  const contactEmail = "support@dropflow-app.com";

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg, #0a0a12)",
      color: "var(--text, #e2e8f0)",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "3rem 1.5rem" }}>

        {/* Header */}
        <div style={{ marginBottom: "2.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
            <span style={{ fontSize: "1.5rem" }}>🔒</span>
            <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>Privacy Policy</h1>
          </div>
          <p style={{ color: "#94a3b8", fontSize: "0.9rem", margin: 0 }}>
            DropFlow — eBay Seller Automation Tool<br />
            Last updated: {lastUpdated}
          </p>
        </div>

        <Section title="1. Overview">
          <p>
            DropFlow ("the Application," "we," "us") is a private seller productivity tool that helps authorized eBay sellers discover, review, and publish products to their eBay stores using the eBay API. This Privacy Policy explains how we collect, use, store, and protect information in connection with your use of DropFlow.
          </p>
          <p>
            DropFlow is not a public platform. Access is restricted to a small group of authorized users. By using DropFlow, you agree to the practices described in this policy.
          </p>
        </Section>

        <Section title="2. Information We Collect">
          <SubSection title="2.1 Account Information">
            <p>We collect your email address and authentication credentials solely for the purpose of granting you access to DropFlow. We use Firebase Authentication (Google) to manage user accounts. We do not store passwords directly.</p>
          </SubSection>
          <SubSection title="2.2 eBay API Data">
            <p>To operate the Application, we temporarily access and process the following data from eBay through official eBay APIs:</p>
            <ul>
              <li>Product listings from eBay (titles, images, prices, item specifics)</li>
              <li>eBay OAuth tokens for authorized eBay seller accounts</li>
              <li>eBay Business Policy IDs (fulfillment, payment, return)</li>
              <li>Merchant location keys</li>
            </ul>
            <p>
              All eBay Content is accessed exclusively through the official eBay Developers Program APIs in compliance with the eBay API License Agreement. We do not scrape, crawl, or access eBay data outside of authorized API methods.
            </p>
          </SubSection>
          <SubSection title="2.3 Operational Data">
            <p>We store the following data in Google Firestore to operate the Application:</p>
            <ul>
              <li>Product queue data (eBay item IDs, titles, images, pricing — temporary)</li>
              <li>Search configuration preferences (keywords, price filters)</li>
              <li>eBay store connection data (store IDs, connected status)</li>
              <li>Listing publication history (eBay listing IDs, publication timestamps)</li>
            </ul>
          </SubSection>
          <SubSection title="2.4 Usage Logs">
            <p>We collect server-side logs for debugging and performance monitoring. These logs include API call records, error messages, and timestamps. Logs do not contain personally identifiable information beyond user IDs.</p>
          </SubSection>
        </Section>

        <Section title="3. How We Use Your Information">
          <p>We use collected information solely for the following purposes:</p>
          <ul>
            <li>To authenticate and authorize access to the Application</li>
            <li>To search for and display eBay product listings for your review</li>
            <li>To publish approved products to your eBay store via the Trading API</li>
            <li>To manage your eBay store connections and business policies</li>
            <li>To maintain a record of published listings for your reference</li>
            <li>To operate automated cleanup processes that delete stale data</li>
          </ul>
          <p>
            <strong>We do not use eBay Content to train, fine-tune, or improve any artificial intelligence or machine learning model.</strong> AI features (title/description rewriting via Anthropic Claude API) process eBay data in a stateless manner — no eBay data is retained by Anthropic or used for model training.
          </p>
          <p>We do not sell, rent, share, or transfer your data or eBay Content to any third party for commercial purposes.</p>
        </Section>

        <Section title="4. Data Retention and Deletion">
          <ul>
            <li><strong>Rejected products:</strong> Deleted from the product queue immediately upon rejection. A minimal reference record (item ID only) is retained for 90 days to prevent duplicate processing, then permanently deleted.</li>
            <li><strong>Approved products not published:</strong> Automatically deleted after 30 days of inactivity.</li>
            <li><strong>Published listings:</strong> A reference record is retained for 90 days, then deleted.</li>
            <li><strong>OAuth tokens:</strong> Retained while your store is connected. Deleted immediately upon store disconnection.</li>
            <li><strong>Account data:</strong> Retained while your account is active. Deleted within 10 days of account termination upon request.</li>
          </ul>
          <p>
            An automated cleanup process runs daily to enforce the above retention periods. You may also request manual deletion of your data at any time by contacting us at {contactEmail}.
          </p>
        </Section>

        <Section title="5. Third-Party Services">
          <p>DropFlow relies on the following third-party services to operate:</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #2d3748" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: "#94a3b8" }}>Service</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: "#94a3b8" }}>Purpose</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: "#94a3b8" }}>Privacy Policy</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["eBay Developer APIs", "Product data, listing publication", "ebay.com/help/policies/member-behaviour-policies/ebay-privacy-notice"],
                ["Google Firebase / Firestore", "Authentication, data storage", "firebase.google.com/support/privacy"],
                ["Anthropic Claude API", "AI title/description rewriting (stateless)", "anthropic.com/privacy"],
                ["Vercel", "Application hosting", "vercel.com/legal/privacy-policy"],
                ["Google Cloud Scheduler", "Automated cleanup tasks", "cloud.google.com/terms/cloud-privacy-notice"],
              ].map(([service, purpose, url]) => (
                <tr key={service} style={{ borderBottom: "1px solid #1e2235" }}>
                  <td style={{ padding: "0.6rem 0.75rem", fontWeight: 600 }}>{service}</td>
                  <td style={{ padding: "0.6rem 0.75rem", color: "#94a3b8" }}>{purpose}</td>
                  <td style={{ padding: "0.6rem 0.75rem" }}>
                    <a href={`https://${url}`} target="_blank" rel="noopener noreferrer"
                      style={{ color: "#60a5fa", fontSize: "0.78rem", textDecoration: "none" }}>
                      View →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="6. eBay Content Compliance">
          <p>As a participant in the eBay Developers Program, we comply with the eBay API License Agreement regarding the use of eBay Content:</p>
          <ul>
            <li>eBay Content is used exclusively to facilitate access to and use of eBay Services</li>
            <li>eBay Content is not combined with third-party data for competitive analysis</li>
            <li>eBay Content is not used to derive platform-wide statistics or category pricing data</li>
            <li>eBay Content is deleted when no longer necessary for its intended purpose</li>
            <li>We are subscribed to eBay Marketplace Account Deletion notifications and process deletion requests promptly</li>
          </ul>
        </Section>

        <Section title="7. Security">
          <p>We implement the following technical and organizational measures to protect your data:</p>
          <ul>
            <li>All data is encrypted in transit (HTTPS/TLS) and at rest (Firestore encryption)</li>
            <li>Authentication is handled via Firebase (Google) with industry-standard security</li>
            <li>eBay OAuth tokens are stored server-side and never exposed to the browser</li>
            <li>API keys and secrets are stored as environment variables, never in client-side code</li>
            <li>Access to the Application is restricted to authorized users only</li>
            <li>Automated daily cleanup removes stale data to minimize data exposure</li>
          </ul>
        </Section>

        <Section title="8. Your Rights">
          <p>As a user of DropFlow, you have the right to:</p>
          <ul>
            <li><strong>Access:</strong> Request a copy of the data we hold about you</li>
            <li><strong>Deletion:</strong> Request deletion of your account and all associated data</li>
            <li><strong>Correction:</strong> Request correction of inaccurate data</li>
            <li><strong>Portability:</strong> Request an export of your data in a machine-readable format</li>
          </ul>
          <p>To exercise any of these rights, contact us at <a href={`mailto:${contactEmail}`} style={{ color: "#60a5fa" }}>{contactEmail}</a>. We will respond within 30 days.</p>
        </Section>

        <Section title="9. Children's Privacy">
          <p>DropFlow is not directed at individuals under the age of 18. We do not knowingly collect personal information from minors. If you believe a minor has provided us with personal information, please contact us immediately.</p>
        </Section>

        <Section title="10. Changes to This Policy">
          <p>We may update this Privacy Policy from time to time. We will notify authorized users of material changes via email. Continued use of the Application after changes take effect constitutes acceptance of the updated policy.</p>
        </Section>

        <Section title="11. Contact">
          <p>For questions, data requests, or concerns regarding this Privacy Policy:</p>
          <div style={{ background: "#111120", border: "1px solid #2d3748", borderRadius: 8, padding: "1rem 1.25rem", marginTop: "0.75rem" }}>
            <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>DropFlow</div>
            <div style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
              Email: <a href={`mailto:${contactEmail}`} style={{ color: "#60a5fa" }}>{contactEmail}</a><br />
              Website: <a href="https://dropflow-app.com" style={{ color: "#60a5fa" }}>dropflow-app.com</a>
            </div>
          </div>
        </Section>

      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#e2e8f0", marginBottom: "0.75rem", paddingBottom: "0.5rem", borderBottom: "1px solid #1e2235" }}>
        {title}
      </h2>
      <div style={{ color: "#94a3b8", fontSize: "0.9rem", lineHeight: 1.75 }}>
        {children}
      </div>
    </div>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <h3 style={{ fontSize: "0.9rem", fontWeight: 600, color: "#cbd5e1", marginBottom: "0.4rem" }}>{title}</h3>
      {children}
    </div>
  );
}