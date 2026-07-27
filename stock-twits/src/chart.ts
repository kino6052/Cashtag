import type { PricePoint } from "./types";

const VIEW_W = 800;
const VIEW_H = 220;
const PAD = 24;

interface ChartHandle {
  /** Programmatically move the selection marker (does not re-trigger onSelect). */
  select(date: string): void;
}

export function renderChart(
  container: HTMLElement,
  prices: PricePoint[],
  onSelect: (point: PricePoint) => void,
): ChartHandle {
  const values = prices.map((p) => p.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const xAt = (i: number) => PAD + (i / (prices.length - 1)) * (VIEW_W - PAD * 2);
  const yAt = (close: number) => VIEW_H - PAD - ((close - min) / range) * (VIEW_H - PAD * 2);

  const linePath = prices.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(p.close)}`).join(" ");
  const areaPath = `${linePath} L${xAt(prices.length - 1)},${VIEW_H - PAD} L${xAt(0)},${VIEW_H - PAD} Z`;

  container.innerHTML = `
    <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" class="chart-svg" role="img" aria-label="Price chart">
      <path d="${areaPath}" class="chart-area"></path>
      <path d="${linePath}" class="chart-line"></path>
      <circle class="chart-marker" r="5" cx="${xAt(prices.length - 1)}" cy="${yAt(prices[prices.length - 1].close)}"></circle>
      <text class="chart-label" x="${PAD}" y="14">$${max.toFixed(2)}</text>
      <text class="chart-label" x="${PAD}" y="${VIEW_H - 6}">$${min.toFixed(2)}</text>
      <text class="chart-label chart-label-end" x="${VIEW_W - PAD}" y="14">${prices[0].date}</text>
      <text class="chart-label chart-label-end" x="${VIEW_W - PAD}" y="${VIEW_H - 6}">${prices[prices.length - 1].date}</text>
    </svg>
  `;

  const svg = container.querySelector("svg") as SVGSVGElement;
  const marker = container.querySelector(".chart-marker") as SVGCircleElement;

  const nearestIndex = (clientX: number): number => {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * VIEW_W;
    let closest = 0;
    let closestDist = Infinity;
    prices.forEach((_, i) => {
      const dist = Math.abs(xAt(i) - relX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    });
    return closest;
  };

  const moveMarker = (i: number) => {
    marker.setAttribute("cx", String(xAt(i)));
    marker.setAttribute("cy", String(yAt(prices[i].close)));
  };

  svg.addEventListener("click", (event) => {
    const i = nearestIndex(event.clientX);
    moveMarker(i);
    onSelect(prices[i]);
  });

  return {
    select(date: string) {
      const i = prices.findIndex((p) => p.date === date);
      if (i >= 0) moveMarker(i);
    },
  };
}
