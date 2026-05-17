import * as THREE from 'three';
import { getBlock } from './utils';

export function raycast(
  origin: THREE.Vector3, 
  direction: THREE.Vector3, 
  maxDistance: number
): { hit: boolean, pt?: THREE.Vector3, norm?: THREE.Vector3, voxel?: THREE.Vector3, prev?: THREE.Vector3 } {
    let t = 0;
    
    // Shift origin so that grid cells map to Math.floor
    const startX = origin.x + 0.5;
    const startY = origin.y + 0.5;
    const startZ = origin.z + 0.5;

    // Grid coords
    let ix = Math.floor(startX);
    let iy = Math.floor(startY);
    let iz = Math.floor(startZ);

    const stepX = Math.sign(direction.x);
    const stepY = Math.sign(direction.y);
    const stepZ = Math.sign(direction.z);

    const tDeltaX = stepX !== 0 ? Math.abs(1 / direction.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / direction.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / direction.z) : Infinity;

    let tMaxX = stepX !== 0 ? (ix + (stepX > 0 ? 1 : 0) - startX) / direction.x : Infinity;
    let tMaxY = stepY !== 0 ? (iy + (stepY > 0 ? 1 : 0) - startY) / direction.y : Infinity;
    let tMaxZ = stepZ !== 0 ? (iz + (stepZ > 0 ? 1 : 0) - startZ) / direction.z : Infinity;

    let steppedIndex = -1;

    let prevX = ix;
    let prevY = iy;
    let prevZ = iz;

    while (t <= maxDistance) {
        const block = getBlock(ix, iy, iz);
        if (block !== 0 && block !== 4) {
            return {
                hit: true,
                voxel: new THREE.Vector3(ix, iy, iz),
                prev: new THREE.Vector3(prevX, prevY, prevZ),
                norm: new THREE.Vector3(
                    steppedIndex === 0 ? -stepX : 0,
                    steppedIndex === 1 ? -stepY : 0,
                    steppedIndex === 2 ? -stepZ : 0
                )
            };
        }

        prevX = ix;
        prevY = iy;
        prevZ = iz;

        if (tMaxX < tMaxY) {
            if (tMaxX < tMaxZ) {
                ix += stepX;
                t = tMaxX;
                tMaxX += tDeltaX;
                steppedIndex = 0;
            } else {
                iz += stepZ;
                t = tMaxZ;
                tMaxZ += tDeltaZ;
                steppedIndex = 2;
            }
        } else {
            if (tMaxY < tMaxZ) {
                iy += stepY;
                t = tMaxY;
                tMaxY += tDeltaY;
                steppedIndex = 1;
            } else {
                iz += stepZ;
                t = tMaxZ;
                tMaxZ += tDeltaZ;
                steppedIndex = 2;
            }
        }
    }
    return { hit: false };
}
