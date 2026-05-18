import { getBaseHeight } from './utils';

// PRNG for deterministic generation
function mulberry32(a: number) {
    return function() {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

class RNG {
    private fn: () => number;
    constructor(seed: number) { this.fn = mulberry32(seed); }
    float(min = 0, max = 1) { return this.fn() * (max - min) + min; }
    int(min: number, max: number) { return Math.floor(this.float(min, max)); }
    chance(prob: number) { return this.fn() < prob; }
    split() { return new RNG(this.int(0, 999999999)); }
}

interface Ellipsoid {
    cx: number; cy: number; cz: number;
    rx: number; ry: number; rz: number;
    type: 'tunnel' | 'room' | 'ravine';
}

export class CarverSystem {
    private chunkCache = new Map<string, Ellipsoid[]>();

    private getSlope(wx: number, wz: number, baseHeight: number) {
        return Math.max(
            Math.abs(getBaseHeight(wx + 3, wz) - baseHeight),
            Math.abs(getBaseHeight(wx - 3, wz) - baseHeight),
            Math.abs(getBaseHeight(wx, wz + 3) - baseHeight),
            Math.abs(getBaseHeight(wx, wz - 3) - baseHeight)
        );
    }

    private generateChunkFeatures(scx: number, scz: number): Ellipsoid[] {
        const key = `${scx},${scz}`;
        if (this.chunkCache.has(key)) return this.chunkCache.get(key)!;

        // Ensure cache limits
        if (this.chunkCache.size > 2000) {
            const iter = this.chunkCache.keys();
            for (let i = 0; i < 500; i++) this.chunkCache.delete(iter.next().value!);
        }

        const seed = Math.imul(scx, 374761393) ^ Math.imul(scz, 668265261) ^ 1234567;
        const rng = new RNG(seed);
        const shapes: Ellipsoid[] = [];

        // 1. Generate Cave Systems (Tunnels & Rooms)
        let count = 0;
        if (rng.chance(0.2)) count = rng.int(1, 3); // some chunks have 1-2 systems
        else if (rng.chance(0.05)) count = rng.int(3, 5); // rare massive chunk systems

        for (let i = 0; i < count; i++) {
            const startX = scx * 16 + rng.float(0, 16);
            const startY = rng.int(10, 60);
            const startZ = scz * 16 + rng.float(0, 16);

            // Occasional large room replacing the start
            if (rng.chance(0.25)) {
                const r = rng.float(4, 9);
                shapes.push({
                    cx: startX, cy: startY, cz: startZ,
                    rx: r * rng.float(0.9, 1.3),
                    ry: r * rng.float(0.6, 0.9),
                    rz: r * rng.float(0.9, 1.3),
                    type: 'room'
                });
            }

            let tunnelCount = 1;
            if (rng.chance(0.3)) tunnelCount += rng.int(1, 2);

            for (let j = 0; j < tunnelCount; j++) {
                const yaw = rng.float(0, Math.PI * 2);
                const pitch = rng.float(-0.15, 0.15);
                const width = rng.float(1.5, 3.5);
                const length = rng.int(30, 60);
                this.carveTunnel(startX, startY, startZ, yaw, pitch, width, length, rng.split(), shapes, 0);
            }
        }

        // 2. Generate Ravines
        if (rng.chance(0.04)) {
            const startX = scx * 16 + rng.float(0, 16);
            const startY = rng.int(20, 50);
            const startZ = scz * 16 + rng.float(0, 16);

            const yaw = rng.float(0, Math.PI * 2);
            let pitch = rng.float(-0.05, 0.05);
            const length = rng.int(40, 80);
            const baseWidth = rng.float(3, 6);

            let wx = startX, wy = startY, wz = startZ;
            let currentYaw = yaw;

            for (let step = 0; step < length; step++) {
                const t = step / length;
                const rx = baseWidth * (1 + Math.sin(t * Math.PI) * 0.8);
                const ry = rx * rng.float(2.0, 3.5); // very tall

                shapes.push({ cx: wx, cy: wy, cz: wz, rx, ry, rz: rx, type: 'ravine' });

                wx += Math.cos(currentYaw);
                wz += Math.sin(currentYaw);
                wy += Math.sin(pitch);

                currentYaw += rng.float(-0.03, 0.03);
                pitch = pitch * 0.8 + rng.float(-0.02, 0.02);
            }
        }

        this.chunkCache.set(key, shapes);
        return shapes;
    }

    private carveTunnel(x: number, y: number, z: number, yaw: number, pitch: number, width: number, length: number, rng: RNG, shapes: Ellipsoid[], depth: number) {
        if (depth > 2) return;
        
        let branchStep = -1;
        if (depth === 0) branchStep = rng.int(length / 3, (length * 2) / 3);

        let currentYaw = yaw;
        let currentPitch = pitch;
        let currentWidth = width;

        for (let step = 0; step < length; step++) {
            const t = step / length;
            
            // Tunnels bulge in the middle
            const localRadiusH = currentWidth * (1.0 + Math.sin(t * Math.PI) * 0.75);
            const localRadiusV = localRadiusH * rng.float(0.75, 1.0);

            shapes.push({
                cx: x, cy: y, cz: z,
                rx: localRadiusH, ry: localRadiusV, rz: localRadiusH,
                type: 'tunnel'
            });

            // Move forward
            const xDelta = Math.cos(currentYaw) * Math.cos(currentPitch);
            const zDelta = Math.sin(currentYaw) * Math.cos(currentPitch);
            const yDelta = Math.sin(currentPitch);
            
            x += xDelta;
            y += yDelta;
            z += zDelta;

            // Drift
            currentYaw += rng.float(-0.08, 0.08);
            currentPitch = currentPitch * 0.7 + rng.float(-0.05, 0.05);

            if (rng.chance(0.05)) currentWidth *= rng.float(0.9, 1.1);
            if (currentWidth < 1) currentWidth = 1;

            if (step === branchStep && currentWidth > 1.8) {
                this.carveTunnel(x, y, z, currentYaw - Math.PI / 2, currentPitch / 3, currentWidth * 0.75, length - step, rng.split(), shapes, depth + 1);
                this.carveTunnel(x, y, z, currentYaw + Math.PI / 2, currentPitch / 3, currentWidth * 0.75, length - step, rng.split(), shapes, depth + 1);
                return; // STOP main tunnel from continuing to prevent explosion
            }
            
            if (y < -30 || y > 100) break;
        }
    }

    private targetChunkCache = new Map<string, Ellipsoid[]>();

    public getShapesForTargetChunk(cx: number, cz: number): Ellipsoid[] {
        const key = `${cx},${cz}`;
        if (this.targetChunkCache.has(key)) return this.targetChunkCache.get(key)!;

        // Ensure cache limits
        if (this.targetChunkCache.size > 2000) {
            const iter = this.targetChunkCache.keys();
            for (let i = 0; i < 500; i++) this.targetChunkCache.delete(iter.next().value!);
        }

        const intersectingShapes: Ellipsoid[] = [];
        
        // Target chunk AABB bounds
        const minX = cx * 16;
        const maxX = minX + 16;
        const minZ = cz * 16;
        const maxZ = minZ + 16;

        for (let dx = -6; dx <= 6; dx++) {
            for (let dz = -6; dz <= 6; dz++) {
                const shapes = this.generateChunkFeatures(cx + dx, cz + dz);
                for (const s of shapes) {
                    if (s.cx + s.rx >= minX && s.cx - s.rx <= maxX &&
                        s.cz + s.rz >= minZ && s.cz - s.rz <= maxZ) {
                        intersectingShapes.push(s);
                    }
                }
            }
        }

        this.targetChunkCache.set(key, intersectingShapes);
        return intersectingShapes;
    }

    private lastCx = -999999;
    private lastCz = -999999;
    private lastShapes: Ellipsoid[] = [];

    public isCarved(wx: number, wy: number, wz: number, baseHeight: number): boolean {
        const cx = Math.floor(wx / 16);
        const cz = Math.floor(wz / 16);
        
        let shapes = this.lastShapes;
        if (cx !== this.lastCx || cz !== this.lastCz) {
            shapes = this.getShapesForTargetChunk(cx, cz);
            this.lastCx = cx;
            this.lastCz = cz;
            this.lastShapes = shapes;
        }

        if (shapes.length === 0) return false;

        const minBreachDepth = 3; 

        for (const s of shapes) {
            // fast Y bounds check
            if (wy < s.cy - s.ry || wy > s.cy + s.ry) continue;

            const dx0 = (wx - s.cx) / s.rx;
            const dy0 = (wy - s.cy) / s.ry;
            const dz0 = (wz - s.cz) / s.rz;

            if (dx0 * dx0 + dy0 * dy0 + dz0 * dz0 < 1.0) {
                const depth = baseHeight - wy;
                
                // Surface breach prevention
                if (depth <= minBreachDepth) {
                    if (baseHeight <= 14) continue; // prevent opening caves under water/beach
                    const slope = this.getSlope(wx, wz, baseHeight);
                    if (slope < 3) continue; // too flat to breach, skip carving at surface
                }
                
                return true;
            }
        }
        return false;
    }
}

export const globalCarver = new CarverSystem();
