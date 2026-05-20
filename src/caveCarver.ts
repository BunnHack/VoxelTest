import { getBaseHeight, noise2D, SEA_LEVEL } from './utils';

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

    private getSurfaceRoof(shapeType: 'tunnel' | 'room' | 'ravine'): number {
        if (shapeType === 'tunnel') return 6;
        if (shapeType === 'room') return 8;
        if (shapeType === 'ravine') return 10;
        return 6;
    }

    private allowedNearSurface(shape: Ellipsoid, baseHeight: number, wy: number): boolean {
        const depth = baseHeight - wy;
        if (shape.type !== 'tunnel') return true;
        if (depth <= 5) {
            if (shape.rx > 2.4 || shape.ry > 2.0) return false;
        }
        return true;
    }

    private canSurfaceBreach(shape: Ellipsoid, wx: number, wy: number, wz: number, baseHeight: number): boolean {
        const depth = baseHeight - wy;

        if (shape.type === 'tunnel') {
            if (baseHeight <= SEA_LEVEL + 2) return false;
            const slope = this.getSlope(wx, wz, baseHeight);
            if (slope < 4) return false;
            const n = noise2D(wx * 0.02 + 500, wz * 0.02 - 500);
            if (n <= 0.72) return false;
            if (depth > 5) return true;
            return true;
        }

        if (shape.type === 'room') {
            if (depth <= 7) return false;
            if (depth <= 10) {
                const slope = this.getSlope(wx, wz, baseHeight);
                if (slope < 6) return false;
                const n = noise2D(wx * 0.015 + 900, wz * 0.015 - 900);
                if (n <= 0.93) return false;
            }
            return true;
        }

        if (shape.type === 'ravine') {
            if (baseHeight <= SEA_LEVEL + 6) return false;
            if (depth <= 10) return false;
            if (depth <= 14) {
                const slope = this.getSlope(wx, wz, baseHeight);
                if (slope < 7) return false;
                const n = noise2D(wx * 0.012 + 1300, wz * 0.012 - 1300);
                if (n <= 0.96) return false;
            }
            return true;
        }

        return false;
    }

    private entranceVerticalWeight(baseHeight: number, wy: number): number {
        const depth = baseHeight - wy;
        if (depth < 2) return 0;
        if (depth <= 5) return 1;
        if (depth <= 8) return 0.5;
        return 0;
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
        if (rng.chance(0.1)) count = 1;
        else if (rng.chance(0.05)) count = 2;
        else if (rng.chance(0.01)) count = 3;

        for (let i = 0; i < count; i++) {
            const startX = scx * 16 + rng.float(0, 16);
            let startY = rng.int(-22, 12);
            const startZ = scz * 16 + rng.float(0, 16);

            // Occasional large room replacing the start
            if (rng.chance(0.15)) {
                startY = rng.int(-24, 6);
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
        if (rng.chance(0.015)) {
            const startX = scx * 16 + rng.float(0, 16);
            const startY = rng.int(-24, 0);
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
        if (depth === 0 && rng.chance(0.4)) branchStep = rng.int(length / 3, (length * 2) / 3);

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

    private maskCache = new Map<string, Uint8Array>();

    public isCarved(wx: number, wy: number, wz: number): boolean {
        const cx = Math.floor(wx / 16);
        const cy = Math.floor(wy / 16);
        const cz = Math.floor(wz / 16);
        
        const key = `${cx},${cy},${cz}`;
        let mask = this.maskCache.get(key);
        if (!mask) {
            mask = this.generateMask(cx, cy, cz);
            this.maskCache.set(key, mask);
            
            if (this.maskCache.size > 2000) {
                const iter = this.maskCache.keys();
                for (let i = 0; i < 500; i++) this.maskCache.delete(iter.next().value!);
            }
        }

        const lx = wx - cx * 16;
        const ly = wy - cy * 16;
        const lz = wz - cz * 16;
        
        return mask[lx * 256 + ly * 16 + lz] === 1;
    }

    private generateMask(cx: number, cy: number, cz: number): Uint8Array {
        const mask = new Uint8Array(4096);
        const shapes = this.getShapesForTargetChunk(cx, cz);
        if (shapes.length === 0) return mask;

        const minY = cy * 16;
        const maxY = minY + 16;
        
        const localShapes = shapes.filter(s => 
            s.cy + s.ry >= minY && s.cy - s.ry <= maxY
        );
        if (localShapes.length === 0) return mask;

        const minX = cx * 16;
        const minZ = cz * 16;

        for (let lx = 0; lx < 16; lx++) {
            const wx = minX + lx;
            for (let lz = 0; lz < 16; lz++) {
                const wz = minZ + lz;
                
                const baseHeight = getBaseHeight(wx, wz);

                for (let ly = 0; ly < 16; ly++) {
                    const wy = minY + ly;
                    
                    for (const s of localShapes) {
                        if (wy < s.cy - s.ry || wy > s.cy + s.ry) continue;

                        const dx0 = (wx - s.cx) / s.rx;
                        const dy0 = (wy - s.cy) / s.ry;
                        const dz0 = (wz - s.cz) / s.rz;

                        if (dx0 * dx0 + dy0 * dy0 + dz0 * dz0 < 1.0) {
                            const depth = baseHeight - wy;
                            const roof = this.getSurfaceRoof(s.type);
                            
                            if (depth > roof) {
                                mask[lx * 256 + ly * 16 + lz] = 1;
                                break;
                            }

                            if (!this.allowedNearSurface(s, baseHeight, wy)) continue;

                            if (!this.canSurfaceBreach(s, wx, wy, wz, baseHeight)) continue;

                            const vWeight = this.entranceVerticalWeight(baseHeight, s.cy);
                            if (vWeight === 0) continue;
                            if (vWeight < 1) {
                                // Deterministic random check for partial weight
                                const r = noise2D(wx * 0.1, wz * 0.1) * 0.5 + 0.5; // map -1..1 to 0..1
                                if (r > vWeight) continue;
                            }
                            
                            mask[lx * 256 + ly * 16 + lz] = 1;
                            break; 
                        }
                    }
                }
            }
        }
        return mask;
    }
}

export const globalCarver = new CarverSystem();
