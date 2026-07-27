export interface PricePoint {
  /** ISO date, e.g. "2024-02-14" */
  date: string;
  close: number;
}

export type Sentiment = "Bullish" | "Bearish" | null;

export interface Twit {
  id: number;
  symbol: string;
  username: string;
  /** ISO date, matches a PricePoint["date"] */
  date: string;
  body: string;
  sentiment: Sentiment;
  likes: number;
}
