import type { PricePoint, Sentiment, Twit } from "../types";

const SYMBOL = "AAPL";

/** Deterministic PRNG so results are stable for a given seed. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return hash;
}

const pick = <T,>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];

function businessDays(start: Date, count: number): Date[] {
  const days: Date[] = [];
  const cursor = new Date(start);
  while (days.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function generatePrices(): PricePoint[] {
  const rand = mulberry32(20240101);
  const days = businessDays(new Date("2024-01-02"), 90);
  let price = 185;
  return days.map((d) => {
    const drift = 0.05;
    const volatility = (rand() - 0.5) * 4;
    price = Math.max(120, price + drift + volatility);
    return { date: toISODate(d), close: Math.round(price * 100) / 100 };
  });
}

const USERNAMES = [
  "chart_wolf", "bullish_barb", "options_owl", "dip_buyer_dan", "swingtrader99",
  "value_vera", "momentum_mo", "the_real_analyst", "quiet_capital", "red_candle_ray",
  "iron_condor", "shortseller_sam", "longterm_lena", "peak_perf", "market_maven",
  "gap_up_gary", "trendline_tina", "risk_off_rick", "buyback_bella", "night_owl_nate",
  "call_writer_cat", "bagholder_ben", "float_rotation", "premarket_pete", "vwap_vince",
  "earnings_ella", "macro_mike", "scalper_sue", "hodl_harold", "breakout_bree",
];

const BULLISH_TEMPLATES = [
  (sym: string, p: string) => `${sym} breaking out above resistance, looks strong here at ${p}.`,
  (sym: string, p: string) => `Loaded up more ${sym} at ${p}. Volume confirms the move up.`,
  (sym: string, p: string) => `${sym} holding the trendline nicely, ${p} looks like a good entry.`,
  (sym: string, p: string) => `Calls printing on ${sym}. ${p} and climbing, this trend has legs.`,
  (sym: string, p: string) => `${sym} $${p} — accumulation phase over, next leg up incoming.`,
  (sym: string, p: string) => `${sym} squeezing shorts at ${p}, this could run further.`,
  (sym: string, p: string) => `Added to my ${sym} position at ${p}, chart structure is bullish.`,
];

const BEARISH_TEMPLATES = [
  (sym: string, p: string) => `${sym} losing momentum, ${p} could retest support soon.`,
  (sym: string, p: string) => `Trimmed my ${sym} position at ${p}, chart looks toppy.`,
  (sym: string, p: string) => `${sym} rejected at resistance again. ${p} feels heavy here.`,
  (sym: string, p: string) => `Puts on ${sym}, ${p} is not holding up on volume.`,
  (sym: string, p: string) => `${sym} $${p} — this rally looks exhausted, watching for a pullback.`,
  (sym: string, p: string) => `${sym} breaking the trendline at ${p}, getting defensive here.`,
  (sym: string, p: string) => `Closed out ${sym} at ${p}, don't like the price action.`,
];

const NEUTRAL_TEMPLATES = [
  (sym: string, p: string) => `${sym} consolidating around ${p}, waiting for a clearer signal.`,
  (sym: string, p: string) => `Anyone else watching ${sym} at ${p}? Feels like a coin flip today.`,
  (sym: string, p: string) => `${sym} earnings coming up, ${p} could move fast either direction.`,
  (sym: string, p: string) => `Flat day for ${sym}, ${p} basically unchanged from the open.`,
  (sym: string, p: string) => `${sym} $${p} — low volume, not much conviction either way today.`,
];

export const symbol = SYMBOL;
export const prices: PricePoint[] = generatePrices();

const MIN_TWITS_PER_DAY = 100;
export const MAX_TWITS_PER_DAY = 150;

/**
 * Generates a fresh batch of twits for a given date, computed on demand
 * (no backend, no precomputed dataset) but deterministic per date.
 */
export function generateTwitsForDate(date: string): Twit[] {
  const idx = prices.findIndex((p) => p.date === date);
  const point = idx >= 0 ? prices[idx] : prices[prices.length - 1];
  const prev = idx > 0 ? prices[idx - 1] : undefined;
  const changedUp = prev ? point.close >= prev.close : true;

  const rand = mulberry32(hashString(date));
  const count = MIN_TWITS_PER_DAY + Math.floor(rand() * (MAX_TWITS_PER_DAY - MIN_TWITS_PER_DAY));

  const twits: Twit[] = [];
  for (let i = 0; i < count; i++) {
    const priceLabel = point.close.toFixed(2);
    const roll = rand();
    let sentiment: Sentiment;
    let body: string;

    if (roll < 0.6) {
      sentiment = changedUp ? "Bullish" : "Bearish";
      body = pick(rand, changedUp ? BULLISH_TEMPLATES : BEARISH_TEMPLATES)(SYMBOL, priceLabel);
    } else if (roll < 0.85) {
      sentiment = changedUp ? "Bearish" : "Bullish";
      body = pick(rand, changedUp ? BEARISH_TEMPLATES : BULLISH_TEMPLATES)(SYMBOL, priceLabel);
    } else {
      sentiment = null;
      body = pick(rand, NEUTRAL_TEMPLATES)(SYMBOL, priceLabel);
    }

    twits.push({
      id: i + 1,
      symbol: SYMBOL,
      username: pick(rand, USERNAMES),
      date: point.date,
      body,
      sentiment,
      likes: Math.floor(rand() * 40),
    });
  }

  return twits;
}
