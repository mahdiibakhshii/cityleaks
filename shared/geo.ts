/**
 * Georeferencing: convert in-game IMAGE/DATA coordinates (origin top-left, +X
 * right, +Y DOWN, 1 unit = 1 source pixel — see CLAUDE.md golden rule #3) to
 * real-world latitude / longitude, so a sticky note's map position can be opened
 * in Google Maps.
 *
 * Model: a single AFFINE transform fitted from a handful of control points
 * (landmarks whose image px AND real lat/long we know):
 *
 *     lng = A·x + B·y + C
 *     lat = D·x + E·y + F
 *
 * Affine captures translation + scale + rotation + shear, so it works whether or
 * not the aerial image is perfectly north-up or uniformly scaled. With ≥3
 * non-collinear points it solves exactly; with more it's a least-squares fit
 * (averages out click imprecision and tiny projection nonlinearity). At Vienna's
 * city scale the residual error is ~meters — plenty to find the spot in Maps.
 *
 * TO CALIBRATE: open /monitor?calibrate=1, click a sharp landmark on the map
 * (the console / on-screen readout prints its image x,y), look up the SAME spot
 * in Google Maps (right-click → "What's here?") for its lat,lng, and add the
 * pair below. Add 4–6 spread across the city for a good fit.
 */

export interface GeoControlPoint {
  /** Human label, for sanity only (e.g. "Stephansdom"). */
  name: string;
  /** Image/data coordinates (the values shown by the calibration readout). */
  x: number;
  y: number;
  /** Real-world coordinates from Google Maps. */
  lat: number;
  lng: number;
}

/**
 * Calibration control points. EMPTY until measured — while empty, imageToLatLng
 * returns null and the monitor simply omits the Maps link. Fill this in (≥3
 * non-collinear, ideally 4–6 spread out) to switch lat/long on.
 */
export const GEO_CONTROL_POINTS: GeoControlPoint[] = [
  { name: 'TMK', x: 8424, y: 9645, lat: 48.20789316224316, lng: 16.3824801789608 },
  { name: 'TopLeftAnchor', x: 714, y: 2061, lat: 48.217966704373225, lng: 16.36718617764933 },
  { name: 'TopRightAnchor', x: 13176, y: 2260, lat: 48.217961178361165, lng: 16.391845179765294 },
  { name: 'MonetariaeAnchor', x: 8707, y: 12986, lat: 48.20343747314235, lng: 16.38292224087011 },
  { name: 'DownLeftAnchor', x: 1344, y: 14405, lat: 48.20154514144373, lng: 16.36823050811242 },
];

export interface LatLng {
  lat: number;
  lng: number;
}

interface AffineFit {
  lng: [number, number, number]; // [A, B, C]
  lat: [number, number, number]; // [D, E, F]
}

/**
 * Solve the 3×3 linear system m·p = b by Cramer's rule. Returns null if the
 * matrix is (near-)singular. m is row-major.
 */
function solve3(m: number[][], b: number[]): [number, number, number] | null {
  const det = (a: number[][]): number =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);

  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;

  // Cramer's rule: replace column i with b, take det / det(m).
  const solveCol = (i: number): number => {
    const mc = m.map((row) => row.slice());
    for (let r = 0; r < 3; r++) mc[r][i] = b[r];
    return det(mc) / d;
  };
  return [solveCol(0), solveCol(1), solveCol(2)];
}

/**
 * Fit the affine transform from the control points via least squares (normal
 * equations). Returns null if there aren't enough non-degenerate points.
 */
function fitAffine(points: GeoControlPoint[]): AffineFit | null {
  if (points.length < 3) return null;

  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0;
  let SxLng = 0, SyLng = 0, SLng = 0;
  let SxLat = 0, SyLat = 0, SLat = 0;
  const n = points.length;

  for (const p of points) {
    Sxx += p.x * p.x;
    Sxy += p.x * p.y;
    Syy += p.y * p.y;
    Sx += p.x;
    Sy += p.y;
    SxLng += p.x * p.lng;
    SyLng += p.y * p.lng;
    SLng += p.lng;
    SxLat += p.x * p.lat;
    SyLat += p.y * p.lat;
    SLat += p.lat;
  }

  const normal: number[][] = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, n],
  ];

  const lng = solve3(normal, [SxLng, SyLng, SLng]);
  const lat = solve3(normal, [SxLat, SyLat, SLat]);
  if (!lng || !lat) return null;
  return { lng, lat };
}

let cachedFit: AffineFit | null | undefined;

function getFit(): AffineFit | null {
  if (cachedFit === undefined) cachedFit = fitAffine(GEO_CONTROL_POINTS);
  return cachedFit;
}

/** True once enough control points are calibrated to convert coordinates. */
export function geoAvailable(): boolean {
  return getFit() !== null;
}

/** Image/data (x,y) → {lat,lng}, or null if not calibrated yet. */
export function imageToLatLng(x: number, y: number): LatLng | null {
  const fit = getFit();
  if (!fit) return null;
  const lng = fit.lng[0] * x + fit.lng[1] * y + fit.lng[2];
  const lat = fit.lat[0] * x + fit.lat[1] * y + fit.lat[2];
  return { lat, lng };
}

/** A Google Maps URL pointing at the note's real-world location, or null. */
export function googleMapsUrl(x: number, y: number): string | null {
  const ll = imageToLatLng(x, y);
  if (!ll) return null;
  return `https://www.google.com/maps?q=${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`;
}

/** "48.20849, 16.37346" — compact display form, or null. */
export function formatLatLng(x: number, y: number): string | null {
  const ll = imageToLatLng(x, y);
  if (!ll) return null;
  return `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
}
