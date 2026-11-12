/**
 * SyntraVariga Umbrella & Health Data
 * Cross-links AhaWissenschaft and SyntraVariga products and marketing assets.
 */

export interface UmbrellaProduct {
  id: string;
  category: "Health & Senior Safety" | "Financial Guard" | "Phygital Merch" | "Content & Education";
  name: string;
  tagline: string;
  legalAnchor: string;
  monetization: string;
  status: "ACTIVE" | "PROTOTYPE" | "B2B_PILOT";
}

export const UMBRELLA_PRODUCTS: UmbrellaProduct[] = [
  {
    id: "SYN-HEALTH-01",
    category: "Health & Senior Safety",
    name: "SyntraVariga Akut-Kompass (TTS)",
    tagline: "Offline-fähiger Notfall-Entscheidungsbaum mit ruhiger deutscher Sprachführung.",
    legalAnchor: "§ 680 BGB (Haftungsausschluss für Ersthelfer) & § 323c StGB",
    monetization: "Freemium Basis / 19,90 € Pro-Familien-Lizenz",
    status: "ACTIVE",
  },
  {
    id: "SYN-HEALTH-02",
    category: "Health & Senior Safety",
    name: "Rentner-Zuschuss-Kalkulator & Antrags-Generator",
    tagline: "Automatische Ermittlung von bis zu 8.360 € Treppenlift- & Wohnumfeld-Zuschüssen.",
    legalAnchor: "§ 40 Abs. 4 SGB XI, § 40 Abs. 1 SGB XI, § 45b SGB XI",
    monetization: "Lead-Provision (150 € - 350 € pro Treppenlift-Lead) / 14,90 € E-Book",
    status: "ACTIVE",
  },
  {
    id: "SYN-FINANCE-01",
    category: "Financial Guard",
    name: "SyntraVariga Invoice & Payment Guard",
    tagline: "Deterministische Rechnungsprüfung mit PayPal Sandbox Checkout & SHA-256 Audit-Ledger.",
    legalAnchor: "GoBD & RFC 8785 Canonical JSON / FIPS 180-4",
    monetization: "B2B SaaS / Hackathon Submission",
    status: "ACTIVE",
  },
  {
    id: "SYN-MERCH-01",
    category: "Phygital Merch",
    name: "Kollektion „Werkzeug Mensch“ (Ärmel-QR-Code)",
    tagline: "Premium Bio-Hoodies & T-Shirts mit funktionalem Notfall-QR-Code am Handgelenk.",
    legalAnchor: "DSGVO (Offline-Routing ohne Tracker)",
    monetization: "Print-on-Demand E-Commerce (18,50 € - 41,40 € Deckungsbeitrag)",
    status: "ACTIVE",
  },
  {
    id: "SYN-MEDIA-01",
    category: "Content & Education",
    name: "AhaWissenschaft Podcast & DenkLabor",
    tagline: "Mensch, KI und die Kunst, richtig zu entscheiden. Kognitive Gamification & Fakten-Check.",
    legalAnchor: "Urheberrecht & Quellentrennung [Meinung] vs. [Fachquelle]",
    monetization: "B2B-Sponsoring (450 € - 2.500 € / Partner bei 10k+ Spotify-Streams)",
    status: "ACTIVE",
  },
];
