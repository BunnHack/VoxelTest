import { getDensity, getBlock, CHUNK_SIZE, blockEdits } from './utils';

const faceConfig = [
    { dir: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // top
    { dir: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] }, // bottom
    { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // left
    { dir: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] }, // right
    { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // front
    { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] } // back
];

self.onmessage = (e) => {
    if (e.data.action === 'setBlock') {
        blockEdits.set(`${e.data.x},${e.data.y},${e.data.z}`, e.data.type);
        return;
    }

    const { id, cx, cy, cz } = e.data;

    // Bounds Analysis (Face Culling & LOD - Skip logic)
    let minDensity = Infinity;
    let maxDensity = -Infinity;

    // Fast bounds evaluation using a coarse grid
    for(let sy = -1; sy <= CHUNK_SIZE + 1; sy += 4) {
        for(let sx = -1; sx <= CHUNK_SIZE + 1; sx += 4) {
            for(let sz = -1; sz <= CHUNK_SIZE + 1; sz += 4) {
                const wx = cx * CHUNK_SIZE + sx;
                const wy = cy * CHUNK_SIZE + sy;
                const wz = cz * CHUNK_SIZE + sz;
                const den = getDensity(wx, wy, wz);
                if (den < minDensity) minDensity = den;
                if (den > maxDensity) maxDensity = den;
            }
        }
    }
    
    // Safety margin since we only evaluated points 4 units apart.
    const margin = 8;
    minDensity -= margin;
    maxDensity += margin;

    // Trees exist up to ~10 blocks above the ground, so if maxDensity < -40 it's definitely air.
    // If minDensity > 10 it's definitely pure solid dirt/stone deep underground (no trees).
    if (maxDensity < -40 || (minDensity > 10 && cy < -2)) {
        (self as unknown as Worker).postMessage({
            id,
            isEmpty: true
        });
        return;
    }

    const typeData: Record<number, { positions: number[], normals: number[], uvs: number[], indices: number[], ndx: number }> = {
        1: { positions: [], normals: [], uvs: [], indices: [], ndx: 0 },
        2: { positions: [], normals: [], uvs: [], indices: [], ndx: 0 },
        3: { positions: [], normals: [], uvs: [], indices: [], ndx: 0 },
        4: { positions: [], normals: [], uvs: [], indices: [], ndx: 0 }
    };

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                const worldX = cx * CHUNK_SIZE + lx;
                const worldY = cy * CHUNK_SIZE + ly;
                const worldZ = cz * CHUNK_SIZE + lz;
                
                const blockId = getBlock(worldX, worldY, worldZ);
                if (blockId === 0) continue;
                
                const data = typeData[blockId];
                if (!data) continue;

                for (const { dir, corners } of faceConfig) {
                    const nworldX = worldX + dir[0];
                    const nworldY = worldY + dir[1];
                    const nworldZ = worldZ + dir[2];
                    
                    const neighborId = getBlock(nworldX, nworldY, nworldZ);
                    
                    if (neighborId !== 0) {
                        const isNeighborTransparent = neighborId === 3 || neighborId === 4;
                        if (!isNeighborTransparent) {
                            continue;
                        } else if (neighborId === blockId) {
                            continue;
                        }
                    }

                    const px = cx * CHUNK_SIZE + lx - 0.5;
                    const py = cy * CHUNK_SIZE + ly - 0.5;
                    const pz = cz * CHUNK_SIZE + lz - 0.5;

                    for (const pos of corners) {
                        data.positions.push(px + pos[0], py + pos[1], pz + pos[2]);
                        data.normals.push(...dir);
                    }
                    
                    data.uvs.push(0, 1, 0, 0, 1, 0, 1, 1);
                    data.indices.push(data.ndx, data.ndx + 1, data.ndx + 2, data.ndx, data.ndx + 2, data.ndx + 3);
                    data.ndx += 4;
                }
            }
        }
    }

    const transferList: Transferable[] = [];
    const response: any = { id, isEmpty: false };

    const finalizeBuffer = (name: string, blockType: number) => {
        const d = typeData[blockType];
        if (d.positions.length > 0) {
            const pa = new Float32Array(d.positions);
            const na = new Float32Array(d.normals);
            const ua = new Float32Array(d.uvs);
            const ia = new Uint32Array(d.indices);
            response[name] = { positions: pa.buffer, normals: na.buffer, uvs: ua.buffer, indices: ia.buffer };
            transferList.push(pa.buffer, na.buffer, ua.buffer, ia.buffer);
        } else {
            response[name] = null;
        }
    };

    finalizeBuffer("grass", 1);
    finalizeBuffer("log", 2);
    finalizeBuffer("leaves", 3);
    finalizeBuffer("water", 4);

    (self as unknown as Worker).postMessage(response, transferList);
};
