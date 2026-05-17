import { createNoise2D, createNoise3D } from 'simplex-noise';

// Seeded PRNG
function mulberry32(a: number) {
    return function() {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

const rng = mulberry32(1234);
export const noise2D = createNoise2D(rng);
export const noise3D = createNoise3D(rng);

export const CHUNK_SIZE = 16;
export const RENDER_DISTANCE = 3;

// ─────────────────────────────────────────────────────────────
// FIX 1: Terrain density — 減少 3D noise 振幅，防止地表大坑
//   原: noise3d * 8  →  現: 分層 octave，地表附近 3D noise 趨近於 0
// ─────────────────────────────────────────────────────────────
export function getBaseHeight(worldX: number, worldZ: number): number {
    const s = 0.02;
    // 多八度2D，給山丘更自然的輪廓
    const h0 = noise2D(worldX * s,       worldZ * s)       * 10;
    const h1 = noise2D(worldX * s * 3,   worldZ * s * 3)   * 4;
    const h2 = noise2D(worldX * s * 9,   worldZ * s * 9)   * 1.5;
    return 16 + h0 + h1 + h2;
}

export function getDensity(worldX: number, worldY: number, worldZ: number): number {
    const baseHeight = getBaseHeight(worldX, worldZ);

    // FIX: 3D noise 振幅大幅降低 (8→2.5)
    // 且只在距離地表 8 格以下才逐步生效 → 地表不會再被 3D noise 挖出大坑
    const depthBelow = baseHeight - worldY;
    const surfaceMask = Math.max(0, Math.min(1, (depthBelow - 4) / 8)); // 0 在地表附近, 1 在深處
    const noise3d = noise3D(worldX * 0.04, worldY * 0.04, worldZ * 0.04) * 2.5 * surfaceMask;

    return baseHeight - worldY + noise3d;
}

// ─────────────────────────────────────────────────────────────
// FIX 2: Spaghetti cave 使用正確方法
//   - Y 軸壓縮：洞穴傾向水平延伸，像真實的 spaghetti cave
//   - 閾值從 0.08 提升到 0.13，讓洞穴截面明顯可見（約 2~3 格寬）
//   - depth guard 從 >8 降到 >3，讓洞口可以自然打穿地表
// ─────────────────────────────────────────────────────────────
function sampleCaveNoise(worldX: number, worldY: number, worldZ: number): number {
    const hScale = 0.045; // 水平頻率
    const vScale = 0.025; // 垂直頻率更低 → 洞穴水平延伸

    const n1 = noise3D(worldX * hScale,          worldY * vScale,          worldZ * hScale);
    const n2 = noise3D(worldX * hScale + 31337,  worldY * vScale + 31337,  worldZ * hScale + 31337);

    // sqrt(n1²+n2²) 接近 0 ⟹ 兩個 noise 同時靠近 0 ⟹ 隧道中心
    return Math.sqrt(n1 * n1 + n2 * n2);
}

export function getBaseBlock(worldX: number, worldY: number, worldZ: number): number {
    if (worldY < -30) return 1; // 底部永遠是實體石頭

    const isSolid = getDensity(worldX, worldY, worldZ) > 0;
    if (!isSolid) return 0;

    const baseHeight = getBaseHeight(worldX, worldZ);
    const depthBelow = baseHeight - worldY;

    // FIX 2a: 洞穴閾值提高到 0.13（原 0.08），洞穴截面明顯
    const CAVE_THRESHOLD = 0.13;
    const caveVal = sampleCaveNoise(worldX, worldY, worldZ);

    if (caveVal < CAVE_THRESHOLD) {
        // FIX 2b: depth guard 降到 3，讓洞穴可以自然打出地表洞口
        // 越接近地表，閾值越收窄（tapering），避免地表破碎
        if (depthBelow > 8) {
            return 0; // 完整洞穴
        } else if (depthBelow > 3) {
            // 漸變收窄 → 在接近地表的地方形成自然洞口邊緣
            const t = (depthBelow - 3) / 5.0; // 0→1
            const taperedThreshold = CAVE_THRESHOLD * t * 0.7;
            if (caveVal < taperedThreshold) return 0;
        }
        // depthBelow <= 3：不挖洞（保護地表結構），但洞口已由上方 >3 處自然形成
    }

    return 1; // 實體地塊
}

// ─────────────────────────────────────────────────────────────
// FIX 3: 樹不再長在坑裡
//   getTreeBaseY 加入高度偏差檢查：
//   若找到的實際地表 Y 與預期地表相差超過 8 格 → 視為大坑，不種樹
// ─────────────────────────────────────────────────────────────
function hashCoordinates(x: number, z: number): number {
    let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265261);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296.0;
}

const treeBaseCache = new Map<string, number>();

export function getTreeBaseY(worldX: number, worldZ: number): number {
    const key = `${worldX},${worldZ}`;
    if (treeBaseCache.has(key)) return treeBaseCache.get(key)!;

    const expectedY = getBaseHeight(worldX, worldZ);

    // 只在預期地表附近搜尋，避免找到坑底
    const searchTop = Math.floor(expectedY + 6);
    const searchBottom = Math.floor(expectedY - 6); // FIX: 原來搜尋範圍 -32，現在限制在 ±6

    let result = -100;
    for (let y = searchTop; y >= searchBottom; y--) {
        if (getBaseBlock(worldX, y, worldZ) === 1 && getBaseBlock(worldX, y + 1, worldZ) === 0) {
            // FIX: 若實際地表 Y 偏離預期超過 8 格（大坑/懸崖底部），跳過
            if (Math.abs(y - expectedY) > 8) break;
            result = y;
            break;
        }
    }

    if (treeBaseCache.size > 10000) treeBaseCache.clear();
    treeBaseCache.set(key, result);
    return result;
}

export const blockEdits = new Map<string, number>();
const blockCache = new Map<string, number>();

export function getBlock(worldX: number, worldY: number, worldZ: number): number {
    const key = `${worldX},${worldY},${worldZ}`;
    if (blockEdits.has(key)) return blockEdits.get(key)!;
    if (blockCache.has(key)) return blockCache.get(key)!;

    let result = 0;

    if (getBaseBlock(worldX, worldY, worldZ) === 1) {
        result = 1; // 地塊
    } else {
        // 樹木生成
        let foundTree = false;
        outer:
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                const tx = worldX + dx;
                const tz = worldZ + dz;

                if (hashCoordinates(tx, tz) < 0.02) {
                    const ty = getTreeBaseY(tx, tz);
                    if (ty <= -50) continue; // 無效地表（在坑裡）→ 跳過

                    // 樹幹：5格高
                    if (dx === 0 && dz === 0 && worldY > ty && worldY <= ty + 5) {
                        result = 2; foundTree = true; break outer;
                    }

                    // 葉子：圓球形狀
                    if (worldY >= ty + 3 && worldY <= ty + 7) {
                        const rPart = dx * dx + dz * dz;
                        const relY = worldY - ty;
                        if (relY <= 5 && rPart <= 4)      { result = 3; foundTree = true; break outer; }
                        if (relY >= 5 && relY <= 7 && rPart <= 1) { result = 3; foundTree = true; break outer; }
                    }
                }
            }
        }
    }

    if (result === 0 && worldY <= 12) {
        result = 4; // Water
    }

    if (blockCache.size > 20000) blockCache.clear();
    blockCache.set(key, result);
    return result;
}

export function getTerrainSurfaceHeight(worldX: number, expectedY: number, worldZ: number): number {
    const startY = Math.floor(expectedY + 1);
    const minSearchY = Math.max(startY - 40, -30);

    for (let y = startY; y >= minSearchY; y--) {
        if (getBlock(worldX, y, worldZ) !== 0 && getBlock(worldX, y + 1, worldZ) === 0) {
            return y;
        }
    }

    return Math.floor(getBaseHeight(worldX, worldZ));
}

