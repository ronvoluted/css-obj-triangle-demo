#!/usr/bin/env tsx
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";

// ── Vector math ─────────────────────────────────────────────────────────

type Vec3 = { x: number; y: number; z: number };
type Face = [number, number, number];

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function mul(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function lengthOf(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}
function normalize(v: Vec3): Vec3 {
  const len = lengthOf(v);
  if (len < 1e-9) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
function fmt(value: number): string {
  const rounded = Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(6));
  return String(rounded);
}

// ── OBJ parsing ─────────────────────────────────────────────────────────

function resolveIndex(index: number, count: number): number {
  if (index > 0) return index - 1;
  if (index < 0) return count + index;
  throw new Error("OBJ indices are 1-based; 0 is invalid.");
}

type ParsedFace = {
  verts: Face;
  /** Per-vertex normal indices (-1 if not specified). */
  normalIndices: [number, number, number];
};

function parseOBJ(text: string): { vertices: Vec3[]; normals: Vec3[]; faces: ParsedFace[] } {
  const vertices: Vec3[] = [];
  const normals: Vec3[] = [];
  const faces: ParsedFace[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);

    if (parts[0] === "v" && parts.length >= 4) {
      const x = Number(parts[1]),
        y = Number(parts[2]),
        z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) vertices.push({ x, y, z });
      continue;
    }

    if (parts[0] === "vn" && parts.length >= 4) {
      const x = Number(parts[1]),
        y = Number(parts[2]),
        z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) normals.push({ x, y, z });
      continue;
    }

    if (parts[0] === "f" && parts.length >= 4) {
      const tokens = parts.slice(1);
      const vertRefs: number[] = [];
      const normRefs: number[] = [];

      for (const tok of tokens) {
        const segs = tok.split("/");
        const vi = Number(segs[0]);
        if (!Number.isFinite(vi)) continue;
        vertRefs.push(resolveIndex(vi, vertices.length));
        // Parse normal index from v/vt/vn or v//vn
        let ni = -1;
        if (segs.length >= 3 && segs[2] !== "") {
          const raw = Number(segs[2]);
          if (Number.isFinite(raw)) ni = resolveIndex(raw, normals.length);
        }
        normRefs.push(ni);
      }

      if (vertRefs.length < 3) continue;
      for (let i = 1; i < vertRefs.length - 1; i++) {
        faces.push({
          verts: [vertRefs[0], vertRefs[i], vertRefs[i + 1]],
          normalIndices: [normRefs[0], normRefs[i], normRefs[i + 1]],
        });
      }
    }
  }
  return { vertices, normals, faces };
}

// ── Geometry pipeline ───────────────────────────────────────────────────

interface ImportOpts {
  axisScale: Vec3;
  center: boolean;
  fitTo: number;
}

const DEFAULTS: ImportOpts = {
  axisScale: { x: 1, y: -1, z: 1 },
  center: true,
  fitTo: 250,
};

function getBounds(verts: Vec3[]) {
  if (!verts.length) {
    const z = { x: 0, y: 0, z: 0 };
    return { min: z, max: z, size: z, center: z };
  }
  let min = { ...verts[0] },
    max = { ...verts[0] };
  for (const v of verts) {
    min = { x: Math.min(min.x, v.x), y: Math.min(min.y, v.y), z: Math.min(min.z, v.z) };
    max = { x: Math.max(max.x, v.x), y: Math.max(max.y, v.y), z: Math.max(max.z, v.z) };
  }
  return { min, max, size: sub(max, min), center: mul(add(min, max), 0.5) };
}

/**
 * Build a map from vertex index → canonical index, merging vertices at the
 * same geometric position. This is needed because many OBJ files have
 * duplicate vertices at seam boundaries.
 */
function buildVertexCanonMap(verts: Vec3[]): Int32Array {
  const canon = new Int32Array(verts.length);
  const posMap = new Map<string, number>();
  for (let i = 0; i < verts.length; i++) {
    const key = `${verts[i].x.toFixed(8)},${verts[i].y.toFixed(8)},${verts[i].z.toFixed(8)}`;
    const existing = posMap.get(key);
    if (existing !== undefined) {
      canon[i] = existing;
    } else {
      posMap.set(key, i);
      canon[i] = i;
    }
  }
  return canon;
}

/**
 * Canonical undirected edge key using deduplicated vertex indices.
 */
function edgeKey(a: number, b: number, canon: Int32Array): string {
  const ca = canon[a], cb = canon[b];
  return ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
}

/**
 * Ensure consistent outward winding across the mesh.
 *
 * 1. If OBJ normals are available, use them per-face (authoritative).
 * 2. Otherwise, use edge-adjacency propagation: pick a seed face per connected
 *    component (oriented via center heuristic), then BFS to neighbours.
 *    Two faces sharing an edge should traverse it in opposite directions;
 *    if they don't, one of them gets flipped.
 */
function fixWinding(
  verts: Vec3[],
  faces: ParsedFace[],
  objNormals: Vec3[],
  axisScale: Vec3,
): Face[] {
  const n = faces.length;
  const out: Face[] = faces.map((f) => [...f.verts] as Face);

  // ── Strategy 1: OBJ normals (per-face, authoritative) ──
  let hasAnyNormal = false;
  for (const f of faces) {
    for (const ni of f.normalIndices) {
      if (ni >= 0 && ni < objNormals.length) { hasAnyNormal = true; break; }
    }
    if (hasAnyNormal) break;
  }

  if (hasAnyNormal) {
    const center = getBounds(verts).center;
    for (let fi = 0; fi < n; fi++) {
      const [ia, ib, ic] = out[fi];
      const a = verts[ia], b = verts[ib], c = verts[ic];
      const geoNormal = cross(sub(b, a), sub(c, a));

      // Average the per-vertex OBJ normals (axis-scaled)
      let sum = { x: 0, y: 0, z: 0 };
      let cnt = 0;
      for (const ni of faces[fi].normalIndices) {
        if (ni >= 0 && ni < objNormals.length) {
          const raw = objNormals[ni];
          sum = {
            x: sum.x + raw.x * axisScale.x,
            y: sum.y + raw.y * axisScale.y,
            z: sum.z + raw.z * axisScale.z,
          };
          cnt++;
        }
      }

      let shouldFlip: boolean;
      if (cnt > 0 && lengthOf(sum) > 1e-9) {
        shouldFlip = dot(geoNormal, sum) < 0;
      } else {
        const centroid = mul(add(add(a, b), c), 1 / 3);
        shouldFlip = dot(geoNormal, sub(centroid, center)) < 0;
      }
      if (shouldFlip) out[fi] = [ia, ic, ib];
    }
    return out;
  }

  // ── Strategy 2: edge-adjacency BFS propagation ──

  // Merge duplicate vertices by position so seam edges connect properly.
  const canon = buildVertexCanonMap(verts);

  // Build edge → face adjacency map.
  // "forward" means the face traverses the edge in canonical (lo→hi) order.
  type EdgeEntry = { faceIdx: number; forward: boolean };
  const edgeMap = new Map<string, EdgeEntry[]>();

  for (let fi = 0; fi < n; fi++) {
    const [ia, ib, ic] = out[fi];
    const edges: [number, number][] = [[ia, ib], [ib, ic], [ic, ia]];
    for (const [ea, eb] of edges) {
      const key = edgeKey(ea, eb, canon);
      const forward = canon[ea] < canon[eb];
      let list = edgeMap.get(key);
      if (!list) { list = []; edgeMap.set(key, list); }
      list.push({ faceIdx: fi, forward });
    }
  }

  // BFS per connected component — first make winding consistent, then
  // use a majority vote to decide whether the component faces outward.
  const visited = new Uint8Array(n);
  const flipped = new Uint8Array(n); // relative to original winding
  const center = getBounds(verts).center;

  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;

    // Collect the component via BFS (seed starts un-flipped; propagate consistency)
    const component: number[] = [seed];
    visited[seed] = 1;

    const queue = [seed];
    while (queue.length) {
      const fi = queue.shift()!;
      const [ia, ib, ic] = out[fi];
      const faceFlipped = flipped[fi];
      const edges: [number, number][] = faceFlipped
        ? [[ib, ia], [ic, ib], [ia, ic]]
        : [[ia, ib], [ib, ic], [ic, ia]];

      for (const [ea, eb] of edges) {
        const key = edgeKey(ea, eb, canon);
        const faceForward = canon[ea] < canon[eb];
        const neighbours = edgeMap.get(key);
        if (!neighbours) continue;

        for (const nb of neighbours) {
          if (nb.faceIdx === fi || visited[nb.faceIdx]) continue;
          visited[nb.faceIdx] = 1;
          if (faceForward === nb.forward) {
            flipped[nb.faceIdx] = 1;
          }
          component.push(nb.faceIdx);
          queue.push(nb.faceIdx);
        }
      }
    }

    // Majority vote: after making winding consistent, check whether the
    // component's normals mostly point outward or inward.
    let outward = 0;
    let inward = 0;
    for (const fi of component) {
      let [ia, ib, ic] = out[fi];
      if (flipped[fi]) [ib, ic] = [ic, ib]; // effective winding
      const a = verts[ia], b = verts[ib], c = verts[ic];
      const geoNormal = cross(sub(b, a), sub(c, a));
      const centroid = mul(add(add(a, b), c), 1 / 3);
      if (dot(geoNormal, sub(centroid, center)) >= 0) outward++;
      else inward++;
    }

    // If majority points inward, flip the entire component
    if (inward > outward) {
      for (const fi of component) {
        flipped[fi] = flipped[fi] ? 0 : 1;
      }
    }
  }

  // Apply flips
  for (let fi = 0; fi < n; fi++) {
    if (flipped[fi]) {
      const [ia, ib, ic] = out[fi];
      out[fi] = [ia, ic, ib];
    }
  }

  return out;
}

function prepare(
  parsed: { vertices: Vec3[]; normals: Vec3[]; faces: ParsedFace[] },
  opts: ImportOpts = DEFAULTS,
): { vertices: Vec3[]; faces: Face[] } {
  let verts = parsed.vertices.map((v) => ({
    x: v.x * opts.axisScale.x,
    y: v.y * opts.axisScale.y,
    z: v.z * opts.axisScale.z,
  }));

  if (opts.center) {
    const bounds = getBounds(verts);
    verts = verts.map((v) => sub(v, bounds.center));
  }
  if (opts.fitTo > 0) {
    const bounds = getBounds(verts);
    const maxDim = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-9);
    const s = opts.fitTo / maxDim;
    verts = verts.map((v) => mul(v, s));
  }

  const faces = fixWinding(verts, parsed.faces, parsed.normals, opts.axisScale);

  return { vertices: verts, faces };
}

// ── Per-triangle output ─────────────────────────────────────────────────

const TRI_BASE = 1;

function triangleMatrix3d(a: Vec3, b: Vec3, c: Vec3): string | null {
  const ex = sub(b, a);
  const ey = sub(c, a);
  const n = cross(ex, ey);
  const nl = lengthOf(n);
  if (nl < 1e-6) return null;
  const un = mul(n, 1 / nl);
  const s = 1 / TRI_BASE;
  return `matrix3d(${[
    ex.x * s, ex.y * s, ex.z * s, 0,
    ey.x * s, ey.y * s, ey.z * s, 0,
    un.x, un.y, un.z, 0,
    a.x, a.y, a.z, 1,
  ].map(fmt).join(",")})`;
}

function faceColor(faceIndex: number, normal: Vec3): string {
  const lightDir = normalize({ x: 0.35, y: -0.45, z: 1.0 });
  const lambert = Math.max(0.22, dot(normalize(normal), lightDir));
  const hue = (faceIndex * 37 + 210) % 360;
  const lightness = 28 + lambert * 34;
  return `hsl(${fmt(hue)}, 72%, ${fmt(lightness)}%)`;
}

// ── Emitters ────────────────────────────────────────────────────────────

function buildTriangleDivs(objText: string): string {
  const prepared = prepare(parseOBJ(objText));
  const lines: string[] = [];

  prepared.faces.forEach((face, i) => {
    const a = prepared.vertices[face[0]];
    const b = prepared.vertices[face[1]];
    const c = prepared.vertices[face[2]];
    const normal = normalize(cross(sub(b, a), sub(c, a)));
    const mat = triangleMatrix3d(a, b, c);
    if (!mat) return;
    const color = faceColor(i, normal);
    const bg = `linear-gradient(to bottom right, ${color} 50%, transparent 50%)`;
    lines.push(
      `        <div class="triangle" style="transform:${mat};background:${bg};backface-visibility:hidden"></div>`,
    );
  });

  return lines.join("\n");
}

function emitHTML(name: string, triangleDivs: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CSS 3D – ${name}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="demo">
      <h1 class="title">CSS 3D &ndash; ${name}</h1>
      <p class="subtitle">
        Every triangle is a static <code>&lt;div&gt;</code> with a baked
        <code>matrix3d()</code> transform. Zero runtime JS &mdash; pure HTML + CSS.
      </p>

      <div class="scene">
        <div class="mesh">
${triangleDivs}
        </div>
      </div>
    </main>
  </body>
</html>
`;
}

function emitCSS(): string {
  return `:root {
  --scene-size: min(78vmin, 760px);
  --scene-perspective: 900px;
}

* {
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  margin: 0;
}

body {
  display: grid;
  place-items: center;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #e8eef9;
  background:
    radial-gradient(circle at top, #1a2436 0%, #0e1420 38%, #080b12 72%),
    #080b12;
  overflow: hidden;
}

.demo {
  display: grid;
  gap: 1rem;
  justify-items: center;
}

.title {
  margin: 0;
  font-size: clamp(1.15rem, 2vw, 1.6rem);
  font-weight: 700;
}

.subtitle {
  margin: 0;
  color: #aab6cf;
  text-align: center;
  max-width: 60ch;
}

.scene {
  position: relative;
  width: var(--scene-size);
  aspect-ratio: 1;
  perspective: var(--scene-perspective);
  perspective-origin: 50% 50%;
  overflow: visible;
  border-radius: 24px;
  border: 1px solid rgba(180, 208, 255, 0.18);
  background:
    radial-gradient(circle at 50% 45%, rgba(105, 165, 255, 0.14), rgba(0, 0, 0, 0) 36%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.42),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.scene::before,
.scene::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.scene::before {
  background:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px) 50% 50% / 32px 32px,
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px) 50% 50% / 32px 32px;
  mask-image: radial-gradient(circle at center, black 56%, transparent 86%);
}

.scene::after {
  background:
    linear-gradient(transparent calc(50% - 0.5px), rgba(140, 172, 230, 0.35) 0, transparent calc(50% + 0.5px)),
    linear-gradient(90deg, transparent calc(50% - 0.5px), rgba(140, 172, 230, 0.35) 0, transparent calc(50% + 0.5px));
}

.mesh {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  transform-style: preserve-3d;
  animation: spin 10s linear infinite;
}

@keyframes spin {
  from {
    transform: rotateX(-22deg) rotateZ(6deg) rotateY(0deg);
  }
  to {
    transform: rotateX(-22deg) rotateZ(6deg) rotateY(360deg);
  }
}

.triangle {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  transform-origin: 0 0 0;
  will-change: transform;
  pointer-events: none;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
}
`;
}

// ── CLI entry ───────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: pnpx tsx scripts/build-demo.ts <path/to/model.obj> [demo-name]");
    process.exit(1);
  }

  const objPath = resolve(args[0]);
  const objText = readFileSync(objPath, "utf-8");

  const name = args[1] ?? basename(objPath, ".obj");
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const outDir = resolve(projectRoot, "demo", name);

  mkdirSync(outDir, { recursive: true });

  const triangleDivs = buildTriangleDivs(objText);
  const faceCount = (triangleDivs.match(/class="triangle"/g) || []).length;

  writeFileSync(resolve(outDir, "index.html"), emitHTML(name, triangleDivs));
  writeFileSync(resolve(outDir, "styles.css"), emitCSS());

  console.log(`✔ ${outDir}/`);
  console.log(`  index.html  (${faceCount} triangles baked inline)`);
  console.log(`  styles.css`);
  console.log(`  No JS required — pure HTML + CSS.`);
}

main();
