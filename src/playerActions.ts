import { CHUNK_SIZE, blockEdits } from './utils';
import { terrainWorkerManager } from './terrainWorkerManager';

export const chunkEvents = new EventTarget();

export function setBlockMain(x: number, y: number, z: number, type: number) {
    blockEdits.set(`${x},${y},${z}`, type);
    terrainWorkerManager.setBlock(x, y, z, type);
    
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);

    const updateRev = (cx: number, cy: number, cz: number) => {
        const key = `${cx},${cy},${cz}`;
        chunkEvents.dispatchEvent(new Event(key));
    };

    updateRev(cx, cy, cz);

    // If block is on the edge of a chunk, update the neighbor chunk too
    const lx = x - cx * CHUNK_SIZE;
    const ly = y - cy * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;

    if (lx === 0) updateRev(cx - 1, cy, cz);
    if (lx === CHUNK_SIZE - 1) updateRev(cx + 1, cy, cz);
    if (ly === 0) updateRev(cx, cy - 1, cz);
    if (ly === CHUNK_SIZE - 1) updateRev(cx, cy + 1, cz);
    if (lz === 0) updateRev(cx, cy, cz - 1);
    if (lz === CHUNK_SIZE - 1) updateRev(cx, cy, cz + 1);
}
