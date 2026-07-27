import { prices, symbol, generateTwitsForDate } from "./data/generate";
import { renderChart } from "./chart";
import { FloatingTiles } from "./floatingTiles";
import type { PricePoint } from "./types";

const tickerInfo = document.querySelector<HTMLDivElement>("#ticker-info")!;
const chartEl = document.querySelector<HTMLDivElement>("#chart")!;
const tilesEl = document.querySelector<HTMLDivElement>("#tiles")!;

const tiles = new FloatingTiles(tilesEl);
tiles.mount();

function showDate(point: PricePoint): void {
  const dayTwits = generateTwitsForDate(point.date);
  tiles.setTwits(dayTwits);

  const latest = prices[prices.length - 1];
  const changeCls = point.close >= latest.close ? "up" : "down";
  tickerInfo.innerHTML = `
    <span class="ticker-symbol">${symbol}</span>
    <span class="ticker-price ${changeCls}">$${point.close.toFixed(2)}</span>
    <span class="ticker-date">${point.date}</span>
    <span class="ticker-count">${dayTwits.length} twits</span>
  `;
}

const chart = renderChart(chartEl, prices, showDate);

const initial = prices[prices.length - 1];
chart.select(initial.date);
showDate(initial);
