"use strict";
const DEFAULT_IMPORT = {
    axisScale: { x: 1, y: -1, z: 1 },
    center: true,
    fitTo: 260,
    reverseWinding: false,
};
function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function mul(a, scalar) {
    return { x: a.x * scalar, y: a.y * scalar, z: a.z * scalar };
}
function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}
function lengthOf(v) {
    return Math.hypot(v.x, v.y, v.z);
}
function normalize(v) {
    const len = lengthOf(v);
    if (len < 1e-9)
        return { x: 0, y: 0, z: 1 };
    return { x: v.x / len, y: v.y / len, z: v.z / len };
}
function formatNumber(value) {
    const rounded = Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(6));
    return String(rounded);
}
function resolveOBJIndex(index, vertexCount) {
    if (index > 0)
        return index - 1;
    if (index < 0)
        return vertexCount + index;
    throw new Error("OBJ indices are 1-based or negative-relative; 0 is invalid.");
}
function parseOBJ(objText) {
    const vertices = [];
    const faces = [];
    for (const rawLine of objText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const parts = line.split(/\s+/);
        const kind = parts[0];
        if (kind === "v" && parts.length >= 4) {
            const x = Number(parts[1]);
            const y = Number(parts[2]);
            const z = Number(parts[3]);
            if ([x, y, z].every(Number.isFinite)) {
                vertices.push({ x, y, z });
            }
            continue;
        }
        if (kind === "f" && parts.length >= 4) {
            const vertexRefs = parts
                .slice(1)
                .map((token) => token.split("/")[0])
                .filter(Boolean)
                .map((value) => Number(value))
                .filter(Number.isFinite)
                .map((index) => resolveOBJIndex(index, vertices.length));
            if (vertexRefs.length < 3)
                continue;
            for (let i = 1; i < vertexRefs.length - 1; i += 1) {
                faces.push([vertexRefs[0], vertexRefs[i], vertexRefs[i + 1]]);
            }
        }
    }
    return { vertices, faces };
}
function getBounds(vertices) {
    if (vertices.length === 0) {
        const z = { x: 0, y: 0, z: 0 };
        return { min: z, max: z, size: z, center: z };
    }
    let min = { ...vertices[0] };
    let max = { ...vertices[0] };
    for (const vertex of vertices) {
        min = {
            x: Math.min(min.x, vertex.x),
            y: Math.min(min.y, vertex.y),
            z: Math.min(min.z, vertex.z),
        };
        max = {
            x: Math.max(max.x, vertex.x),
            y: Math.max(max.y, vertex.y),
            z: Math.max(max.z, vertex.z),
        };
    }
    const size = sub(max, min);
    const center = mul(add(min, max), 0.5);
    return { min, max, size, center };
}
function prepareOBJ(parsed, options = {}) {
    const axisScale = {
        x: options.axisScale?.x ?? DEFAULT_IMPORT.axisScale.x,
        y: options.axisScale?.y ?? DEFAULT_IMPORT.axisScale.y,
        z: options.axisScale?.z ?? DEFAULT_IMPORT.axisScale.z,
    };
    const center = options.center ?? DEFAULT_IMPORT.center;
    const fitTo = options.fitTo ?? DEFAULT_IMPORT.fitTo;
    const reverseWinding = options.reverseWinding ?? DEFAULT_IMPORT.reverseWinding;
    let vertices = parsed.vertices.map((vertex) => ({
        x: vertex.x * axisScale.x,
        y: vertex.y * axisScale.y,
        z: vertex.z * axisScale.z,
    }));
    if (center) {
        const bounds = getBounds(vertices);
        vertices = vertices.map((vertex) => sub(vertex, bounds.center));
    }
    if (fitTo > 0) {
        const bounds = getBounds(vertices);
        const maxDimension = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-9);
        const scalar = fitTo / maxDimension;
        vertices = vertices.map((vertex) => mul(vertex, scalar));
    }
    const reflectionParity = axisScale.x * axisScale.y * axisScale.z < 0;
    const shouldReverse = reflectionParity !== reverseWinding;
    const faces = shouldReverse
        ? parsed.faces.map(([a, b, c]) => [a, c, b])
        : parsed.faces.slice();
    return { vertices, faces };
}
const TRI_BASE = 100;
function triangleMatrix3d(a, b, c) {
    const edgeX = sub(b, a);
    const edgeY = sub(c, a);
    const normal = cross(edgeX, edgeY);
    const normalLength = lengthOf(normal);
    if (normalLength < 1e-6)
        return null;
    const unitNormal = mul(normal, 1 / normalLength);
    const s = 1 / TRI_BASE;
    const values = [
        edgeX.x * s,
        edgeX.y * s,
        edgeX.z * s,
        0,
        edgeY.x * s,
        edgeY.y * s,
        edgeY.z * s,
        0,
        unitNormal.x,
        unitNormal.y,
        unitNormal.z,
        0,
        a.x,
        a.y,
        a.z,
        1,
    ];
    return `matrix3d(${values.map(formatNumber).join(",")})`;
}
function defaultColorForFace(faceIndex, normal) {
    const lightDir = normalize({ x: 0.35, y: -0.45, z: 1.0 });
    const lambert = Math.max(0.22, dot(normalize(normal), lightDir));
    const hue = (faceIndex * 37 + 210) % 360;
    const lightness = 28 + lambert * 34;
    return `hsl(${formatNumber(hue)}, 72%, ${formatNumber(lightness)}%)`;
}
const cubeOBJ = `
# Unit cube, already triangulated.
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1

f 1 2 3
f 1 3 4

f 5 8 7
f 5 7 6

f 1 5 6
f 1 6 2

f 2 6 7
f 2 7 3

f 3 7 8
f 3 8 4

f 5 1 4
f 5 4 8
`;
function initDemo() {
    const meshEl = document.getElementById("mesh");
    if (!(meshEl instanceof HTMLElement))
        return;
    const prepared = prepareOBJ(parseOBJ(cubeOBJ), {
        axisScale: { x: 1, y: -1, z: 1 },
        center: true,
        fitTo: 250,
        reverseWinding: true,
    });
    prepared.faces.forEach((face, faceIndex) => {
        const [ia, ib, ic] = face;
        const a = prepared.vertices[ia];
        const b = prepared.vertices[ib];
        const c = prepared.vertices[ic];
        const normal = normalize(cross(sub(b, a), sub(c, a)));
        const color = defaultColorForFace(faceIndex, normal);
        const transform = triangleMatrix3d(a, b, c);
        if (!transform)
            return;
        const el = document.createElement("div");
        el.className = "triangle";
        Object.assign(el.style, {
            transform,
            background: `linear-gradient(to bottom right, ${color} 50%, transparent 50%)`,
            backfaceVisibility: "hidden",
        });
        meshEl.appendChild(el);
    });
}
document.addEventListener("DOMContentLoaded", initDemo);
