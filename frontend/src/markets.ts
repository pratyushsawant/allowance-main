// The Markets page watchlist: what each asset is and where its live data comes from.
// Live numbers are fetched in src/marketsApi.ts:
//   prices  -> Yahoo Finance via the /api/yahoo proxy in vite.config.ts (stocks and crypto)
//   crypto  -> CoinGecko adds market cap and 24h volume (one optional call)
//   odds    -> Polymarket (open prediction markets matching `search`)

export type Source = { kind: "crypto"; yahoo: string; coingeckoId: string } | { kind: "stock"; yahoo: string };

export type AssetMeta = {
  symbol: string;
  name: string;
  kind: "Stock" | "Crypto" | "ETF";
  exchange: string;
  color: string; // ticker tile color
  about: string;
  source: Source;
  search: string; // Polymarket search for related prediction markets
};

export const WATCHLIST: AssetMeta[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    kind: "Crypto",
    exchange: "Crypto",
    color: "#f2a33a",
    about: "The largest cryptocurrency by market value. Trades around the clock on exchanges worldwide.",
    source: { kind: "crypto", yahoo: "BTC-USD", coingeckoId: "bitcoin" },
    search: "bitcoin",
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    kind: "Crypto",
    exchange: "Crypto",
    color: "#6f7fe8",
    about: "The second-largest cryptocurrency and the main network for smart contracts and stablecoins.",
    source: { kind: "crypto", yahoo: "ETH-USD", coingeckoId: "ethereum" },
    search: "ethereum",
  },
  {
    symbol: "NVDA",
    name: "NVIDIA Corp.",
    kind: "Stock",
    exchange: "Nasdaq",
    color: "#5aa832",
    about: "Designs graphics processors and the AI accelerators that power most large model training.",
    source: { kind: "stock", yahoo: "NVDA" },
    search: "nvidia",
  },
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    kind: "Stock",
    exchange: "Nasdaq",
    color: "#8a8f98",
    about: "Makes the iPhone, Mac and Apple Watch, and runs a growing services business.",
    source: { kind: "stock", yahoo: "AAPL" },
    search: "apple",
  },
  {
    symbol: "TSLA",
    name: "Tesla Inc.",
    kind: "Stock",
    exchange: "Nasdaq",
    color: "#d8323c",
    about: "Builds electric vehicles, batteries and energy storage, and is developing self-driving software.",
    source: { kind: "stock", yahoo: "TSLA" },
    search: "tesla",
  },
  {
    symbol: "SPY",
    name: "S&P 500 ETF",
    kind: "ETF",
    exchange: "NYSE Arca",
    color: "#3b6fd4",
    about: "Tracks the S&P 500, the 500 largest public companies in the US.",
    source: { kind: "stock", yahoo: "SPY" },
    search: "fed rates",
  },
];

// ---- Live data shapes ----
export type Point = { t: number; price: number; volume: number }; // t = ms since epoch

export type Quote = {
  price: number;
  dayChangePct: number;
  series: Point[]; // daily, oldest first, about 6 months
  volume: number; // latest day / 24h volume (shares for stocks, USD for crypto)
  marketCap?: number; // crypto
  prevClose?: number; // stocks
  high52?: number; // stocks
  low52?: number;
};

export type RelatedMarket = { question: string; yesPrice: number; url: string; volume: number };

export type AssetData = {
  quote?: Quote;
  quoteError?: string;
  related?: RelatedMarket[];
  relatedError?: string;
};

// ---- Formatting ----
export const formatPrice = (n: number) =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);

export const pctChange = (from: number, to: number) => ((to - from) / from) * 100;
