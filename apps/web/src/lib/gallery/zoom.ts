// Pure pinch-zoom math for the PDP's full-screen viewer (docs/plans/pdp-gallery.md §3.3, §6): the
// component only feeds it pointer positions and sizes. Coordinates are px relative to the centre
// of the stage (the viewer's photo area); the photo is drawn with `object-contain`, and a zoom is
// applied as `translate(x, y) scale(scale)` around the stage centre.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
/** What a double-tap at 1x zooms to. */
export const DOUBLE_TAP_SCALE = 2.5;
/** Two taps within this time (ms) and distance (px) of each other are a double-tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;

export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/** The size the photo is drawn at inside the stage (`object-contain`). A photo without a usable
 * size is treated as filling the stage. */
export function containedSize(stage: Size, photoWidth: number, photoHeight: number): Size {
  if (!(photoWidth > 0 && photoHeight > 0)) return stage;
  const ratio = Math.min(stage.width / photoWidth, stage.height / photoHeight);
  return { width: photoWidth * ratio, height: photoHeight * ratio };
}

export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

function clampAxis(offset: number, photo: number, stage: number, scale: number): number {
  const limit = Math.max(0, (photo * scale - stage) / 2);
  // `+ 0` turns a -0 into 0, so a centred photo always reads as exactly 0.
  return Math.min(limit, Math.max(-limit, offset)) + 0;
}

/** Keeps the zoomed photo covering the stage: its edges never come inside the stage on an axis
 * where it is larger than the stage, and it stays centred on an axis where it is not. */
export function clampPan(zoom: Zoom, stage: Size, photo: Size): Zoom {
  const scale = clampScale(zoom.scale);
  return { scale, x: clampAxis(zoom.x, photo.width, stage.width, scale), y: clampAxis(zoom.y, photo.height, stage.height, scale) };
}

/** Scales to `scale` (clamped) keeping the photo point under `point` where it is. Not clamped to
 * the edges: callers that need it run `clampPan` after. */
export function zoomAt(zoom: Zoom, point: Point, scale: number): Zoom {
  const next = clampScale(scale);
  const ratio = next / zoom.scale;
  return { scale: next, x: point.x - (point.x - zoom.x) * ratio, y: point.y - (point.y - zoom.y) * ratio };
}

/** A two-finger gesture as it started: the zoom then, the midpoint of the fingers and their
 * distance apart. */
export interface PinchStart {
  zoom: Zoom;
  centre: Point;
  distance: number;
}

/** The zoom for the fingers' current midpoint and distance: scaled by how far they spread since
 * the start, around the start midpoint, and moved along with the midpoint (two-finger pan). */
export function pinchZoom(start: PinchStart, centre: Point, distance: number, stage: Size, photo: Size): Zoom {
  if (!(start.distance > 0)) return start.zoom;
  const scaled = zoomAt(start.zoom, start.centre, start.zoom.scale * (distance / start.distance));
  return clampPan({ scale: scaled.scale, x: scaled.x + centre.x - start.centre.x, y: scaled.y + centre.y - start.centre.y }, stage, photo);
}

/** One finger dragging the zoomed photo: moved by the finger's travel since `start`. */
export function panZoom(start: Zoom, travel: Point, stage: Size, photo: Size): Zoom {
  return clampPan({ scale: start.scale, x: start.x + travel.x, y: start.y + travel.y }, stage, photo);
}

/** Double-tap: 1x zooms to 2.5x around the tap, anything else goes back to 1x. */
export function toggleZoom(zoom: Zoom, point: Point, stage: Size, photo: Size): Zoom {
  if (zoom.scale > ZOOM_MIN) return NO_ZOOM;
  return clampPan(zoomAt(NO_ZOOM, point, DOUBLE_TAP_SCALE), stage, photo);
}

export interface Tap {
  time: number;
  x: number;
  y: number;
}

export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  if (!previous) return false;
  return tap.time - previous.time <= DOUBLE_TAP_MS && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_SLOP_PX;
}

/** A one-finger drag changes photo only at 1x; zoomed in, it pans instead. */
export function canSwipe(zoom: Zoom): boolean {
  return zoom.scale <= ZOOM_MIN;
}
