import * as THREE from "three";
import {
  CSS3DObject,
  CSS3DRenderer,
} from "three/examples/jsm/renderers/CSS3DRenderer.js";
import type { Twit } from "./types";
import { MAX_TWITS_PER_DAY } from "./data/generate";

const TILE_W = 360;
const TILE_H = 150;
const TUNNEL_DEPTH = 5000;
const AUTO_SCROLL_SPEED = 1;
const FALL_IN_MS = 700;
const FALL_OUT_MS = 500;
const FOCUS_MS = 550;
const MAX_STAGGER_MS = 5;
/** Pool is sized to the largest possible twit batch so tiles are reused, never recreated. */
const POOL_SIZE = MAX_TWITS_PER_DAY;

/** Depth fog: tiles fade/blur/desaturate toward the background as they recede. */
const FOG_NEAR = 900;
const FOG_FAR = 4200;
const FOG_MIN_ALPHA = 0.12;
const FOG_BLUR_BUCKETS = 4;
const FOG_MAX_BLUR_PX = 5;

/**
 * How close to the camera (z -> 0) a tile is allowed to drift before it's
 * recycled. CSS 3D perspective scaling blows up as z approaches 0 — left
 * unchecked, tiles balloon to grotesque size right before wrapping, then
 * the old code hard-teleported position.z by TUNNEL_DEPTH in one frame.
 * That combo of "huge" then "instantly gone" is what reads as flicker.
 */
const WRAP_NEAR_Z = -220;
const RECYCLE_FADE_OUT_MS = 160;
const RECYCLE_FADE_IN_MS = 380;

/** CSS3DRenderer paints tiles in DOM order, not by actual depth, so overlapping
 * tiles can occlude each other incorrectly. Periodically re-append active tiles
 * back-to-front so paint order matches distance from the camera. */
const DEPTH_SORT_INTERVAL_FRAMES = 6;

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

interface ActiveTween {
  startAt: number;
  duration: number;
  update: (t: number) => void;
  onComplete?: () => void;
  /** Tags which slot this tween animates, so a new tween on the same slot can cancel it instead of racing it. */
  slot?: PoolSlot;
}

interface PoolSlot {
  object: CSS3DObject;
  el: HTMLElement;
  userEl: HTMLElement;
  sentimentEl: HTMLElement;
  bodyEl: HTMLElement;
  footerEl: HTMLElement;
  /** Reveal progress (0-1) driven by fall in/out tweens; combined with depth fog for final opacity. */
  revealAlpha: number;
  dimmed: boolean;
  /** Quantized blur level, cached so the (comparatively expensive) filter is only rewritten when it changes. */
  blurBucket: number;
  /** True while being faded out/repositioned/faded back in by the tunnel-wrap recycle; moveTunnel skips it meanwhile. */
  recycling: boolean;
}

interface FocusState {
  slotIndex: number;
  original: { x: number; y: number; z: number };
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t: number): number {
  return t * t * t;
}

/**
 * Renders twits as floating CSS3D tiles drifting through a tunnel, a
 * TypeScript port of the original three.js "floating tiles" effect.
 *
 * Tiles are backed by a fixed pool of reused DOM nodes/CSS3DObjects
 * (sized to the largest possible batch) so swapping the twit set never
 * creates or destroys elements — only repositions and re-labels them.
 */
export class FloatingTiles {
  private readonly container: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer = new CSS3DRenderer();
  private readonly pool: PoolSlot[] = [];
  private readonly resizeObserver: ResizeObserver;
  private tweens: ActiveTween[] = [];
  private autoScroll = true;
  private activeCount = 0;
  private focused: FocusState | null = null;
  private frameId = 0;
  private frameCount = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      1,
      TUNNEL_DEPTH,
    );
    this.camera.position.y = -25;
    this.resizeObserver = new ResizeObserver(this.onResize);

    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push(this.createSlot());
    }
  }

  private createSlot(): PoolSlot {
    const el = document.createElement("div");
    el.className = "tile";
    el.style.width = `${TILE_W}px`;
    el.style.height = `${TILE_H}px`;
    el.style.opacity = "0";
    el.innerHTML = `
      <div class="tile-header">
        <span class="tile-user"></span>
        <span class="tile-sentiment"></span>
      </div>
      <div class="tile-body"></div>
      <div class="tile-footer"></div>
    `;

    const object = new CSS3DObject(el);
    object.visible = false;
    this.scene.add(object);

    const slot: PoolSlot = {
      object,
      el,
      userEl: el.querySelector(".tile-user")!,
      sentimentEl: el.querySelector(".tile-sentiment")!,
      bodyEl: el.querySelector(".tile-body")!,
      footerEl: el.querySelector(".tile-footer")!,
      revealAlpha: 0,
      dimmed: false,
      blurBucket: -1,
      recycling: false,
    };

    return slot;
  }

  mount(): void {
    this.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight,
    );
    this.container.appendChild(this.renderer.domElement);

    this.container.addEventListener("wheel", this.onWheel);
    this.container.addEventListener("click", this.onContainerClick);
    // The container's size can change from layout (e.g. the chart card
    // resizing) without a window resize event, so observe it directly.
    this.resizeObserver.observe(this.container);

    this.frameId = requestAnimationFrame(this.animate);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.container.removeEventListener("wheel", this.onWheel);
    this.container.removeEventListener("click", this.onContainerClick);
    this.resizeObserver.disconnect();
    this.container.innerHTML = "";
  }

  setTwits(twits: Twit[]): void {
    this.clearFocus();

    const count = Math.min(twits.length, this.pool.length);
    const outgoingCount = this.activeCount;
    const staggerOut = outgoingCount
      ? Math.min(MAX_STAGGER_MS, 350 / outgoingCount)
      : 0;

    for (let i = 0; i < outgoingCount; i++) {
      const slot = this.pool[i];
      // Cancel anything still animating this slot (e.g. a mid-flight tunnel
      // recycle) so it can't race the fall-out/fall-in tweens below.
      this.cancelTweensFor(slot);
      slot.recycling = false;
      const fromY = slot.object.position.y;
      const toY = fromY - 2600;
      const stillNeeded = i < count;
      this.tween(
        FALL_OUT_MS,
        (t) => {
          const eased = easeInCubic(t);
          slot.object.position.y = fromY + (toY - fromY) * eased;
          slot.revealAlpha = 1 - eased;
          this.updateTileVisual(slot);
        },
        {
          slot,
          delay: i * staggerOut,
          onComplete: () => {
            if (!stillNeeded) slot.object.visible = false;
          },
        },
      );
    }

    const entryDelay = outgoingCount ? 200 : 0;
    const staggerIn = count ? Math.min(MAX_STAGGER_MS, 400 / count) : 0;

    for (let i = 0; i < count; i++) {
      this.fallInSlot(this.pool[i], twits[i], i, entryDelay + i * staggerIn);
    }

    this.activeCount = count;
  }

  private fallInSlot(
    slot: PoolSlot,
    twit: Twit,
    index: number,
    delay: number,
  ): void {
    // Cancel any tween still in flight for this slot (e.g. the fall-out
    // tween just queued above for a reused index) so they can't race.
    this.cancelTweensFor(slot);
    slot.recycling = false;

    slot.el.className = `tile tile--${twit.sentiment?.toLowerCase() ?? "neutral"}`;
    slot.userEl.textContent = `@${twit.username}`;
    slot.sentimentEl.textContent = twit.sentiment ?? "";
    slot.bodyEl.textContent = twit.body;
    slot.footerEl.textContent = `${twit.date} · ${twit.likes} likes`;

    const targetY = ((index * 137) % 2000) - 1000 + (Math.random() * 200 - 100);
    const startY = targetY + 2200;
    slot.object.position.x = Math.random() * 5000 - 2500;
    slot.object.position.z = Math.random() * -TUNNEL_DEPTH;
    slot.object.position.y = startY;
    slot.object.scale.set(1, 1, 1);
    slot.object.visible = true;
    slot.revealAlpha = 0;
    slot.dimmed = false;
    this.updateTileVisual(slot);

    this.tween(
      FALL_IN_MS,
      (t) => {
        const eased = easeOutCubic(t);
        slot.object.position.y = startY + (targetY - startY) * eased;
        slot.revealAlpha = Math.min(1, t * 2);
        this.updateTileVisual(slot);
      },
      { slot, delay },
    );
  }

  /** Fades, blurs, and desaturates a tile based on distance from the camera, so far tiles sink into the background. */
  private updateTileVisual(slot: PoolSlot): void {
    const depthT = clamp01(
      (Math.abs(slot.object.position.z) - FOG_NEAR) / (FOG_FAR - FOG_NEAR),
    );
    const fogAlpha = 1 - depthT * (1 - FOG_MIN_ALPHA);
    const dimFactor = slot.dimmed ? 0.35 : 1;

    slot.el.style.opacity = String(
      Math.max(0, slot.revealAlpha * fogAlpha * dimFactor),
    );

    const bucket = Math.round(depthT * FOG_BLUR_BUCKETS);
    if (bucket !== slot.blurBucket) {
      slot.blurBucket = bucket;
      const blurPx = (bucket / FOG_BLUR_BUCKETS) * FOG_MAX_BLUR_PX;
      const saturation = 1 - (bucket / FOG_BLUR_BUCKETS) * 0.6;
      slot.el.style.filter =
        bucket === 0
          ? ""
          : `blur(${blurPx.toFixed(1)}px) saturate(${saturation.toFixed(2)})`;
    }
  }

  /** Floats a clicked tile to the center of the view and freezes all other tiles. */
  private focusOn(slotIndex: number): void {
    if (this.focused?.slotIndex === slotIndex) return;
    if (this.focused) this.restoreFocused();

    const slot = this.pool[slotIndex];
    this.cancelTweensFor(slot);
    slot.recycling = false;
    this.focused = {
      slotIndex,
      original: {
        x: slot.object.position.x,
        y: slot.object.position.y,
        z: slot.object.position.z,
      },
    };
    this.autoScroll = false;
    this.setOthersDimmed(slotIndex, true);
    slot.el.classList.add("tile--focused");

    const obj = slot.object;
    const from = {
      x: obj.position.x,
      y: obj.position.y,
      z: obj.position.z,
      s: obj.scale.x,
    };
    const to = { x: 0, y: -25, z: -650, s: 1.4 };
    this.tween(FOCUS_MS, (t) => {
      const e = easeOutCubic(t);
      obj.position.x = from.x + (to.x - from.x) * e;
      obj.position.y = from.y + (to.y - from.y) * e;
      obj.position.z = from.z + (to.z - from.z) * e;
      const s = 2 * (from.s + (to.s - from.s) * e);
      obj.scale.set(s, s, s);
      this.updateTileVisual(slot);
    }, { slot });
  }

  private restoreFocused(): void {
    if (!this.focused) return;
    const { slotIndex, original } = this.focused;
    const slot = this.pool[slotIndex];
    this.cancelTweensFor(slot);
    slot.el.classList.remove("tile--focused");
    this.setOthersDimmed(slotIndex, false);

    const obj = slot.object;
    const from = {
      x: obj.position.x,
      y: obj.position.y,
      z: obj.position.z,
      s: obj.scale.x,
    };
    this.tween(FOCUS_MS, (t) => {
      const e = easeOutCubic(t);
      obj.position.x = from.x + (original.x - from.x) * e;
      obj.position.y = from.y + (original.y - from.y) * e;
      obj.position.z = from.z + (original.z - from.z) * e;
      const s = from.s + (1 - from.s) * e;
      obj.scale.set(s, s, s);
      this.updateTileVisual(slot);
    }, { slot });
    this.focused = null;
  }

  private setOthersDimmed(exceptIndex: number, dim: boolean): void {
    for (let i = 0; i < this.activeCount; i++) {
      if (i === exceptIndex) continue;
      const slot = this.pool[i];
      slot.dimmed = dim;
      slot.el.classList.toggle("tile--dim", dim);
      this.updateTileVisual(slot);
    }
  }

  private clearFocus(): void {
    if (!this.focused) return;
    this.pool[this.focused.slotIndex].el.classList.remove("tile--focused");
    this.setOthersDimmed(this.focused.slotIndex, false);
    this.focused = null;
    this.autoScroll = true;
  }

  /**
   * Picks a tile manually via getBoundingClientRect instead of relying on
   * native DOM hit-testing/bubbling through the element. CSS3DRenderer's
   * deeply nested `perspective()` + `preserve-3d` transform chain makes
   * tiles unreliable click targets in some engines — the browser paints
   * them correctly but excludes them entirely from elementFromPoint's hit
   * stack — so pointer-events-based click handlers on the tiles silently
   * never fire. Rect-based picking sidesteps that.
   */
  private readonly onContainerClick = (event: MouseEvent): void => {
    let bestIndex = -1;
    let bestZ = -Infinity;

    for (let i = 0; i < this.activeCount; i++) {
      const slot = this.pool[i];
      if (slot.dimmed) continue;
      const r = slot.el.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        continue;
      // Among overlapping matches, prefer whichever tile sits closest to the camera (z nearest 0).
      const z = slot.object.position.z;
      if (z > bestZ) {
        bestZ = z;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      this.focusOn(bestIndex);
      return;
    }

    if (this.focused) {
      this.restoreFocused();
      this.autoScroll = true;
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.focused) this.moveTunnel(event.deltaY * -1);
  };

  private moveTunnel(delta: number): void {
    for (let i = 0; i < this.activeCount; i++) {
      const slot = this.pool[i];
      if (slot.recycling) continue;
      const object = slot.object;
      object.position.z += delta;
      if (object.position.z > WRAP_NEAR_Z) {
        this.recycleTile(slot);
        continue;
      }
      // The far end is already almost fully fogged out (see FOG_FAR), so an
      // instant reposition there is imperceptible — only the near/camera
      // crossing (handled above) needs the fade-based recycle.
      if (object.position.z < -TUNNEL_DEPTH) object.position.z += TUNNEL_DEPTH;
      this.updateTileVisual(slot);
    }
  }

  /**
   * Recycles a tile that's drifted too close to the camera: fades it out,
   * repositions it to the far end of the tunnel while invisible, then fades
   * it back in. Replaces the old instant position teleport, which visibly
   * flickered — a tile ballooning to huge size right at the camera, then
   * vanishing to the far end in a single frame.
   */
  private recycleTile(slot: PoolSlot): void {
    this.cancelTweensFor(slot);
    slot.recycling = true;

    this.tween(
      RECYCLE_FADE_OUT_MS,
      (t) => {
        slot.revealAlpha = 1 - t;
        this.updateTileVisual(slot);
      },
      {
        slot,
        onComplete: () => {
          slot.object.position.x = Math.random() * 5000 - 2500;
          slot.object.position.y = Math.random() * 2000 - 1000;
          slot.object.position.z = -TUNNEL_DEPTH + Math.random() * 400;
          this.updateTileVisual(slot);

          this.tween(
            RECYCLE_FADE_IN_MS,
            (t) => {
              slot.revealAlpha = t;
              this.updateTileVisual(slot);
            },
            {
              slot,
              onComplete: () => {
                slot.recycling = false;
              },
            },
          );
        },
      },
    );
  }

  /**
   * CSS3DRenderer paints tiles in DOM order (fixed at first appearance),
   * not by depth, so overlapping tiles can occlude each other incorrectly
   * as they move. Re-append active tiles back-to-front so paint order
   * tracks actual distance from the camera. Runs on an interval rather
   * than every frame since it's a purely cosmetic correction.
   */
  private sortDepth(): void {
    const active = this.pool.slice(0, this.activeCount);
    active.sort((a, b) => a.object.position.z - b.object.position.z);
    for (const slot of active) {
      slot.el.parentElement?.appendChild(slot.el);
    }
  }

  private cancelTweensFor(slot: PoolSlot): void {
    this.tweens = this.tweens.filter((tw) => tw.slot !== slot);
  }

  private tween(
    duration: number,
    update: (t: number) => void,
    opts: { delay?: number; onComplete?: () => void; slot?: PoolSlot } = {},
  ): void {
    this.tweens.push({
      startAt: performance.now() + (opts.delay ?? 0),
      duration,
      update,
      onComplete: opts.onComplete,
      slot: opts.slot,
    });
  }

  private readonly onResize = (): void => {
    this.camera.aspect =
      this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight,
    );
  };

  private readonly animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);

    if (this.tweens.length) {
      const now = performance.now();
      this.tweens = this.tweens.filter((tw) => {
        if (now < tw.startAt) return true;
        const t = Math.min(1, (now - tw.startAt) / tw.duration);
        tw.update(t);
        if (t >= 1) {
          tw.onComplete?.();
          return false;
        }
        return true;
      });
    }

    if (this.autoScroll) this.moveTunnel(AUTO_SCROLL_SPEED);

    this.renderer.render(this.scene, this.camera);

    this.frameCount++;
    if (this.frameCount % DEPTH_SORT_INTERVAL_FRAMES === 0) this.sortDepth();
  };
}
