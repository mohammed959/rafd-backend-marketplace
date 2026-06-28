/**
 * Geospatial helpers for polygon-based delivery coverage.
 *
 * Coordinates are stored and compared as plain {lat, lng} pairs (WGS84
 * degrees). For the small, city-scale polygons an admin draws, treating
 * lat/lng as planar x/y for ray-casting is accurate enough — the error
 * from ignoring earth curvature is negligible at these distances and well
 * below the precision of a hand-drawn boundary.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** A polygon is a ring of >= 3 vertices. The ring is treated as closed
 *  (the last vertex implicitly connects back to the first). */
export type Polygon = LatLng[];

/** True when `poly` is a usable ring (array of >= 3 finite vertices). */
export function isValidPolygon(poly: unknown): poly is Polygon {
  return (
    Array.isArray(poly) &&
    poly.length >= 3 &&
    poly.every(
      (p) =>
        p != null &&
        typeof (p as LatLng).lat === 'number' &&
        typeof (p as LatLng).lng === 'number' &&
        Number.isFinite((p as LatLng).lat) &&
        Number.isFinite((p as LatLng).lng),
    )
  );
}

/**
 * Coerce loosely-typed JSON (e.g. a Prisma `Json` column) into a polygon,
 * or return null when it isn't a valid ring. Accepts arrays of objects with
 * numeric `lat`/`lng`.
 */
export function normalizePolygon(value: unknown): Polygon | null {
  if (!Array.isArray(value)) return null;
  const pts = value
    .map((p) => {
      if (p == null || typeof p !== 'object') return null;
      const lat = Number((p as Record<string, unknown>).lat);
      const lng = Number((p as Record<string, unknown>).lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    })
    .filter((p): p is LatLng => p != null);
  return isValidPolygon(pts) ? pts : null;
}

/** Coerce JSON into an array of polygons, dropping any invalid rings. */
export function normalizePolygons(value: unknown): Polygon[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((ring) => normalizePolygon(ring))
    .filter((p): p is Polygon => p != null);
}

/**
 * Ray-casting point-in-polygon test. Returns true when `point` is strictly
 * inside `polygon` (boundary cases are not guaranteed and don't matter for
 * coverage decisions — a customer exactly on the line is vanishingly rare).
 */
export function pointInPolygon(point: LatLng, polygon: Polygon): boolean {
  const x = point.lng;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** True when `point` falls inside ANY of the given polygons. */
export function pointInAnyPolygon(point: LatLng, polygons: Polygon[]): boolean {
  return polygons.some((poly) => pointInPolygon(point, poly));
}

/**
 * Backend safety check used when saving coverage: every vertex of an
 * excluded ring must sit inside the main delivery polygon. This is an
 * approximation (vertices, not full geometry) but rejects the obvious
 * "excluded area drawn outside the service area" mistake. The admin UI
 * performs the same check before submitting.
 */
export function isPolygonInsidePolygon(inner: Polygon, outer: Polygon): boolean {
  return inner.every((vertex) => pointInPolygon(vertex, outer));
}
