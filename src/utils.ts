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
// 海平面常數 — 統一用這個，不要 hardcode 12
// ─────────────────────────────────────────────────────────────
export const SEA_LEVEL = 12;

// ─────────────────────────────────────────────────────────────
// FIX OCEAN 1: Continentalness noise
//   極低頻率（0.004）→ 決定大範圍是"海洋"還是"陸地"
//   輸出 -1.5 ~ +1.5，< -0.15 = 海洋，> 0.2 = 陸地，中間 = 海岸
// ─────────────────────────────────────────────────────────────
function getContinentalness(worldX: number, worldZ: number): number {
    const c0 = noise2D(worldX * 0.004,  worldZ * 0.004);           // 大尺度
    const c1 = noise2D(worldX * 0.009 + 300, worldZ * 0.009 + 300) * 0.4; // 中尺度修飾
    return c0 + c1; // ≈ -1.4 ~ +1.4
}

// ─────────────────────────────────────────────────────────────
// FIX OCEAN 2: 根據 continentalness 決定地形高度
//   海洋區: 地形 ≈ SEA_LEVEL - 10 ~ SEA_LEVEL - 4  → 水深 4~10 格
//   海岸區: 地形 ≈ SEA_LEVEL - 2 ~ SEA_LEVEL + 3   → 沙灘
//   陸地區: 地形 ≈ SEA_LEVEL + 4 ~ SEA_LEVEL + 20  → 山丘
// ─────────────────────────────────────────────────────────────
export function getBaseHeight(worldX: number, worldZ: number): number {
    const continental = getContinentalness(worldX, worldZ);

    // 陸地細節 noise（多八度）
    const s = 0.022;
    const detail = noise2D(worldX * s, worldZ * s)           * 7
                 + noise2D(worldX * s * 3, worldZ * s * 3)   * 3
                 + noise2D(worldX * s * 8, worldZ * s * 8)   * 1.2;
    // detail ≈ -11.2 ~ +11.2

    if (continental < -0.35) {
        // ── 深海 ──────────────────────────────────────────────
        // continental: -1.4 ~ -0.35, t: 0(邊緣) ~ 1(深海)
        const t = Math.min(1, (continental + 0.35) / -1.05);
        // 海床高度：SEA_LEVEL-5 (邊緣) → SEA_LEVEL-11 (深海)
        const floorBase = SEA_LEVEL - 5 - t * 6;
        return floorBase + detail * 0.25; // 海床非常平坦
    } else if (continental < 0.1) {
        // ── 海岸過渡帶 ────────────────────────────────────────
        // t: 0(靠近深海) ~ 1(靠近陸地)
        const t = (continental + 0.35) / 0.45;
        const tSmooth = t * t * (3 - 2 * t); // smoothstep
        const oceanEdgeHeight = SEA_LEVEL - 4 + detail * 0.4;
        const landEdgeHeight  = SEA_LEVEL + 4 + detail * 0.8;
        return oceanEdgeHeight + (landEdgeHeight - oceanEdgeHeight) * tSmooth;
    } else {
        // ── 陸地 ──────────────────────────────────────────────
        // continental: 0.1 ~ 1.4, t: 0 ~ 1
        const t = Math.min(1, (continental - 0.1) / 1.0);
        // 越深入內陸，地勢越高（山脈）
        const heightBoost = t * 8;
        return SEA_LEVEL + 4 + heightBoost + detail;
    }
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
// ── 1. Spaghetti cave noise（不變，參數已是正確的）────────
function sampleSpaghettiCave(wx: number, wy: number, wz: number): number {
    const hScale = 0.043;
    const vScale = 0.018;
    const n1 = noise3D(wx * hScale,         wy * vScale,         wz * hScale);
    const n2 = noise3D(wx * hScale + 47.23, wy * vScale + 91.07, wz * hScale + 13.84);
    return Math.sqrt(n1 * n1 + n2 * n2);
}

// ── 2. Room noise（Y 軸壓縮 → 扁平洞室）─────────────────
function sampleRoomNoise(wx: number, wy: number, wz: number): number {
    const hScale = 0.015;
    const vScale = 0.008;
    return noise3D(wx * hScale + 1000, wy * vScale + 1000, wz * hScale + 1000);
}

// ── 3. Spaghetti Cave Entrance Check ──────────

export function getBaseBlock(worldX: number, worldY: number, worldZ: number): number {
    if (worldY < -30) return 1;

    const isSolid = getDensity(worldX, worldY, worldZ) > 0;
    if (!isSolid) return 0;

    const baseHeight  = getBaseHeight(worldX, worldZ);
    const depthBelow  = baseHeight - worldY;
    
    if (depthBelow <= 0) return 1;

    // 洞穴粗細 base
    const thickMod = noise3D(worldX * 0.03, worldY * 0.02, worldZ * 0.03);
    const spagBase = 0.31 + thickMod * 0.06;
    const spagVal  = sampleSpaghettiCave(worldX, worldY, worldZ);

    const entranceMask = noise2D(worldX * 0.028 + 2000, worldZ * 0.028 - 2000);

    // 改善地表洞口：不要縮小半徑，而是用 binary mask 來控制開不開口
    if (depthBelow < 4) {
        if (entranceMask < 0.78) return 1; // 大部分地表不開口
        if (spagVal < Math.max(0.34, spagBase)) return 0; // 一旦開口就夠寬
    } else {
        let factor = 1.0;
        if (depthBelow > 50) {
            factor = Math.max(0.6, 1.0 - (depthBelow - 50) / 35.0);
        }
        if (spagVal < spagBase * factor) return 0;
    }

    // ── Cave rooms：threshold 降低 → 洞室更大更明顯 ──────────
    if (depthBelow > 10) {
        const roomFactor    = Math.min(1.0, (depthBelow - 10) / 10.0);
        const roomThreshold = 0.58 - roomFactor * 0.08; // 0.58→0.50
        const roomVal       = sampleRoomNoise(worldX, worldY, worldZ);
        if (roomVal > roomThreshold) return 0;
    }

    return 1;
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

    // ── FIX: 海洋/海岸區不種樹 ──
    const continental = getContinentalness(worldX, worldZ);
    if (continental < 0.15) {
        treeBaseCache.set(key, -100);
        return -100;
    }

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
    const baseHeight = getBaseHeight(worldX, worldZ); // 快取一次

    if (getBaseBlock(worldX, worldY, worldZ) === 1) {
        // ── FIX OCEAN 3: 海底/沙灘用沙 (block 5) ──────────────
        // 海面下，或海面上 1~2 格（沙灘）的地表頂層用沙
        const isNearSea = baseHeight < SEA_LEVEL + 3;
        if (isNearSea) {
            result = 5; // sand
        } else {
            result = 1; // grass/dirt
        }
    } else {
        // ── 樹木生成 ──────────────────────────────────────────
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
                        result = 2; break outer;
                    }

                    // 葉子：圓球形狀
                    if (worldY >= ty + 3 && worldY <= ty + 7) {
                        const rPart = dx * dx + dz * dz;
                        const relY = worldY - ty;
                        if (relY <= 5 && rPart <= 4)      { result = 3; break outer; }
                        if (relY >= 5 && relY <= 7 && rPart <= 1) { result = 3; break outer; }
                    }
                }
            }
        }

        // ── FIX OCEAN 4: 正確的水生成邏輯 ────────────────────
        // 關鍵：只有當「這一 column 的自然地形高度低於海平面」，
        // 且此 block 在地表上方 (worldY > baseHeight) 才填水，防止洞穴進水
        if (result === 0 && worldY <= SEA_LEVEL && worldY > baseHeight) {
            result = 4; // water
        }
    }

    if (blockCache.size > 20000) {
        // LRU-lite: 刪最舊的 5000 個
        const iter = blockCache.keys();
        for (let i = 0; i < 5000; i++) blockCache.delete(iter.next().value);
    }
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

