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

export function getDensity(worldX: number, worldY: number, worldZ: number) {
    const scale = 0.02;
    const noise2d = noise2D(worldX * scale, worldZ * scale);
    const baseHeight = 16 + noise2d * 12;
    
    // 3D noise for caves and overhangs
    const noise3d = noise3D(worldX * 0.05, worldY * 0.05, worldZ * 0.05) * 8;
    
    return baseHeight - worldY + noise3d;
}

export function getBaseBlock(worldX: number, worldY: number, worldZ: number) {
    if (worldY < -20) return 1;
    
    const isSolid = getDensity(worldX, worldY, worldZ) > 0;
    if (!isSolid) return 0;
    
    // Add cave generation using 3D noise
    const caveNoise = Math.abs(noise3D(worldX * 0.06, worldY * 0.06, worldZ * 0.06));
    if (caveNoise < 0.15) {
        // Taper caves slightly near surface
        const scale = 0.02;
        const baseHeight = 16 + noise2D(worldX * scale, worldZ * scale) * 12;
        const depth = baseHeight - worldY;
        if (depth > 8) {
            return 0; // Cave tunnel
        } else if (depth > 2) {
            // transition zone
            if (caveNoise < 0.15 * ((depth - 2) / 6.0)) return 0;
        }
    }
    
    return 1;
}

function hashCoordinates(x: number, z: number) {
    let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265261);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296.0;
}

const treeBaseCache = new Map<string, number>();

export function getTreeBaseY(worldX: number, worldZ: number) {
    const key = `${worldX},${worldZ}`;
    if (treeBaseCache.has(key)) return treeBaseCache.get(key)!;

    let expectedY = 16 + noise2D(worldX * 0.02, worldZ * 0.02) * 12;
    for (let y = Math.floor(expectedY + 16); y >= Math.floor(expectedY - 32); y--) {
        if (getBaseBlock(worldX, y, worldZ) === 1 && getBaseBlock(worldX, y + 1, worldZ) === 0) {
            treeBaseCache.set(key, y);
            
            // Limit cache size to prevent memory leaks
            if (treeBaseCache.size > 10000) {
                const firstKey = treeBaseCache.keys().next().value;
                if (firstKey) treeBaseCache.delete(firstKey);
            }
            return y;
        }
    }
    treeBaseCache.set(key, -100);
    return -100;
}

export const blockEdits = new Map<string, number>();

export function getBlock(worldX: number, worldY: number, worldZ: number) {
    const key = `${worldX},${worldY},${worldZ}`;
    if (blockEdits.has(key)) {
        return blockEdits.get(key)!;
    }

    if (getBaseBlock(worldX, worldY, worldZ) === 1) return 1; // 1 = Grass/Dirt
    
    // Check local neighborhood for tree spawn
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            const tx = worldX + dx;
            const tz = worldZ + dz;
            
            // 2% chance of tree per column
            if (hashCoordinates(tx, tz) < 0.02) {
                const ty = getTreeBaseY(tx, tz);
                if (ty > -50) {
                    // Log: 5 blocks tall
                    if (dx === 0 && dz === 0 && worldY > ty && worldY <= ty + 5) return 2; // 2 = Log
                    
                    // Leaves: spheres around top of tree
                    if (worldY >= ty + 3 && worldY <= ty + 6) {
                         const rPart = dx * dx + dz * dz;
                         if (worldY <= ty + 4 && rPart <= 4) return 3; // 3 = Leaves
                         if (worldY > ty + 4 && rPart <= 1) return 3;
                    }
                }
            }
        }
    }
    
    return 0; // 0 = Air
}

export function getTerrainSurfaceHeight(worldX: number, expectedY: number, worldZ: number) {
    // Start searching from just above the player's current block
    const startY = Math.floor(expectedY + 1);
    const minSearchY = Math.max(startY - 40, -30);
    
    for (let y = startY; y >= minSearchY; y--) {
        // Find the first solid block with an empty block above it
        if (getBlock(worldX, y, worldZ) !== 0 && getBlock(worldX, y + 1, worldZ) === 0) {
            return y;
        }
    }
    
    // Fallback if falling into void
    const scale = 0.02;
    const noise2d = noise2D(worldX * scale, worldZ * scale);
    const baseHeight = 16 + noise2d * 12;
    return Math.floor(baseHeight);
}
