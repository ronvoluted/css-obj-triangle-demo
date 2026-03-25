"use strict";
const DEFAULT_IMPORT = {
    axisScale: { x: 1, y: -1, z: 1 },
    center: true,
    fitTo: 260,
    reverseWinding: false,
};
const DEFAULT_POSE = {
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: -24, y: 36, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
};
function v3(x = 0, y = 0, z = 0) {
    return { x, y, z };
}
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
        return {
            min: v3(),
            max: v3(),
            size: v3(),
            center: v3(),
        };
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
function triangleStyleFromVertices(a, b, c, color = "crimson", doubleSided = false) {
    const transform = triangleMatrix3d(a, b, c);
    if (!transform)
        return null;
    return {
        position: "absolute",
        left: "0",
        top: "0",
        width: `${TRI_BASE}px`,
        height: `${TRI_BASE}px`,
        transformOrigin: "0 0 0",
        transform,
        background: `linear-gradient(to bottom right, ${color} 50%, transparent 50%)`,
        backfaceVisibility: doubleSided ? "visible" : "hidden",
    };
}
function meshTransformCss(pose) {
    return [
        `translate3d(${formatNumber(pose.position.x)}px, ${formatNumber(pose.position.y)}px, ${formatNumber(pose.position.z)}px)`,
        `rotateZ(${formatNumber(pose.rotationDeg.z)}deg)`,
        `rotateY(${formatNumber(pose.rotationDeg.y)}deg)`,
        `rotateX(${formatNumber(pose.rotationDeg.x)}deg)`,
        `scale3d(${formatNumber(pose.scale.x)}, ${formatNumber(pose.scale.y)}, ${formatNumber(pose.scale.z)})`,
    ].join(" ");
}
function applyMeshPose(meshEl, pose) {
    meshEl.style.transform = meshTransformCss(pose);
}
function defaultColorForFace(faceIndex, normal) {
    const lightDir = normalize({ x: 0.35, y: -0.45, z: 1.0 });
    const lambert = Math.max(0.22, dot(normalize(normal), lightDir));
    const hue = (faceIndex * 37 + 210) % 360;
    const lightness = 28 + lambert * 34;
    return `hsl(${formatNumber(hue)}, 72%, ${formatNumber(lightness)}%)`;
}
function renderOBJMesh(meshEl, objText, options = {}) {
    const prepared = prepareOBJ(parseOBJ(objText), options.import);
    const doubleSided = options.doubleSided ?? false;
    const colorForFace = options.colorForFace ?? defaultColorForFace;
    meshEl.replaceChildren();
    prepared.faces.forEach((face, faceIndex) => {
        const [ia, ib, ic] = face;
        const a = prepared.vertices[ia];
        const b = prepared.vertices[ib];
        const c = prepared.vertices[ic];
        const normal = normalize(cross(sub(b, a), sub(c, a)));
        const style = triangleStyleFromVertices(a, b, c, colorForFace(faceIndex, normal), doubleSided);
        if (!style)
            return;
        const triangleEl = document.createElement("div");
        triangleEl.className = "triangle";
        triangleEl.dataset.faceIndex = String(faceIndex);
        Object.assign(triangleEl.style, style);
        meshEl.appendChild(triangleEl);
    });
    applyMeshPose(meshEl, options.pose ?? DEFAULT_POSE);
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
    const sceneEl = document.getElementById("scene");
    const hudEl = document.getElementById("hud");
    if (!(meshEl instanceof HTMLElement) || !(sceneEl instanceof HTMLElement) || !(hudEl instanceof HTMLElement)) {
        return;
    }
    const pose = {
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: -26, y: 30, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
    };
    renderOBJMesh(meshEl, cubeOBJ, {
        import: {
            axisScale: { x: 1, y: -1, z: 1 },
            center: true,
            fitTo: 250,
            reverseWinding: true,
        },
        pose,
        doubleSided: false,
    });
    const updateHud = () => {
        hudEl.textContent = [
            `rotateX: ${pose.rotationDeg.x.toFixed(1)}°`,
            `rotateY: ${pose.rotationDeg.y.toFixed(1)}°`,
            `rotateZ: ${pose.rotationDeg.z.toFixed(1)}°`,
            `translateZ: ${pose.position.z.toFixed(1)}px`,
        ].join("  •  ");
    };
    updateHud();
    let pointerActive = false;
    let previousX = 0;
    let previousY = 0;
    let autoSpin = true;
    sceneEl.addEventListener("pointerdown", (event) => {
        pointerActive = true;
        autoSpin = false;
        previousX = event.clientX;
        previousY = event.clientY;
        sceneEl.setPointerCapture(event.pointerId);
    });
    sceneEl.addEventListener("pointermove", (event) => {
        if (!pointerActive)
            return;
        const dx = event.clientX - previousX;
        const dy = event.clientY - previousY;
        previousX = event.clientX;
        previousY = event.clientY;
        pose.rotationDeg.y += dx * 0.45;
        pose.rotationDeg.x += dy * 0.45;
        applyMeshPose(meshEl, pose);
        updateHud();
    });
    const stopPointer = () => {
        pointerActive = false;
    };
    sceneEl.addEventListener("pointerup", stopPointer);
    sceneEl.addEventListener("pointercancel", stopPointer);
    sceneEl.addEventListener("lostpointercapture", stopPointer);
    sceneEl.addEventListener("wheel", (event) => {
        event.preventDefault();
        pose.position.z += event.deltaY * -0.3;
        pose.position.z = Math.max(-420, Math.min(420, pose.position.z));
        applyMeshPose(meshEl, pose);
        updateHud();
    }, { passive: false });
    let lastTime = performance.now();
    const tick = (now) => {
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        if (autoSpin) {
            pose.rotationDeg.y += dt * 26;
            pose.rotationDeg.x = -20 + Math.sin(now * 0.0011) * 10;
            applyMeshPose(meshEl, pose);
            updateHud();
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
window.CSSOBJ3D = {
    parseOBJ,
    prepareOBJ,
    triangleMatrix3d,
    triangleStyleFromVertices,
    meshTransformCss,
    applyMeshPose,
    renderOBJMesh,
};
document.addEventListener("DOMContentLoaded", initDemo);
