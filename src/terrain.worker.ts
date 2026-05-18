import { getDensity, getBlock, CHUNK_SIZE, blockEdits, SEA_LEVEL } from './utils';
import { globalCarver } from './caveCarver';

const faceConfig = [
    { dir: [0, 1, 0],  corners: [[0,1,0],[0,1,1],[1,1,1],[1,1,0]] },
    { dir: [0,-1, 0],  corners: [[0,0,1],[0,0,0],[1,0,0],[1,0,1]] },
    { dir: [-1,0, 0],  corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]] },
    { dir: [1, 0, 0],  corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]] },
    { dir: [0, 0,-1],  corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]] },
    { dir: [0, 0, 1],  corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
];

// 透明 block 集合
const TRANSPARENT = new Set([3, 4]); // leaves, water

self.onmessage = (e) => {
    if (e.data.action === 'setBlock') {
        const key = `${e.data.x},${e.data.y},${e.data.z}`;
        blockEdits.set(key, e.data.type);
        // blockCache?.delete(key); // 若有 blockCache export 可在此 invalidate
        return;
    }

    const { id, cx, cy, cz } = e.data;

    // ── Bounds check ──────────────────────────────────────────
    // 海平面以上的空 chunk 仍可能有水 → 降低 skip 條件
    let minDensity = Infinity, maxDensity = -Infinity;
    for (let sy = -1; sy <= CHUNK_SIZE + 1; sy += 4)
    for (let sx = -1; sx <= CHUNK_SIZE + 1; sx += 4)
    for (let sz = -1; sz <= CHUNK_SIZE + 1; sz += 4) {
        const d = getDensity(cx*CHUNK_SIZE+sx, cy*CHUNK_SIZE+sy, cz*CHUNK_SIZE+sz);
        if (d < minDensity) minDensity = d;
        if (d > maxDensity) maxDensity = d;
    }
    const margin = 8;
    minDensity -= margin;
    maxDensity += margin;

    // 這個 chunk 頂部 Y
    const chunkTopY = (cy + 1) * CHUNK_SIZE;
    const chunkBotY = cy * CHUNK_SIZE;

    if (minDensity > 10 && cy < -2 && chunkTopY < SEA_LEVEL - 4) {
        // Deep underground, might be solid. Check with carver if there is any cave in this height range.
        let hasCaveInThisLayer = false;
        const shapes = (globalCarver as any).getShapesForTargetChunk ? (globalCarver as any).getShapesForTargetChunk(cx, cz) : [];
        for (const s of shapes) {
            if (s.cy + s.ry >= chunkBotY && s.cy - s.ry <= chunkTopY) {
                hasCaveInThisLayer = true;
                break;
            }
        }
        if (!hasCaveInThisLayer) {
            (self as unknown as Worker).postMessage({ id, isEmpty: true });
            return;
        }
    }

    // 如果整個 chunk 在海面以上且地形密度極低 → skip
    if (maxDensity < -40 && cy * CHUNK_SIZE > SEA_LEVEL + 4) {
        (self as unknown as Worker).postMessage({ id, isEmpty: true });
        return;
    }

    // ── 建 geometry buffers ───────────────────────────────────
    // block type → buffer: 1=grass, 2=log, 3=leaves, 4=water, 5=sand
    const typeData: Record<number, {
        positions: number[]; normals: number[]; uvs: number[]; indices: number[]; ndx: number
    }> = {
        1: { positions:[], normals:[], uvs:[], indices:[], ndx:0 },
        2: { positions:[], normals:[], uvs:[], indices:[], ndx:0 },
        3: { positions:[], normals:[], uvs:[], indices:[], ndx:0 },
        4: { positions:[], normals:[], uvs:[], indices:[], ndx:0 },
        5: { positions:[], normals:[], uvs:[], indices:[], ndx:0 },
    };

    for (let lx = 0; lx < CHUNK_SIZE; lx++)
    for (let lz = 0; lz < CHUNK_SIZE; lz++)
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const worldX = cx * CHUNK_SIZE + lx;
        const worldY = cy * CHUNK_SIZE + ly;
        const worldZ = cz * CHUNK_SIZE + lz;

        const blockId = getBlock(worldX, worldY, worldZ);
        if (blockId === 0) continue;

        const data = typeData[blockId];
        if (!data) continue;

        for (const { dir, corners } of faceConfig) {
            const nbId = getBlock(worldX + dir[0], worldY + dir[1], worldZ + dir[2]);

            // 面剔除規則
            if (nbId !== 0) {
                // 兩者都是同一透明 block → 不渲染（避免水中水面）
                if (nbId === blockId && TRANSPARENT.has(blockId)) continue;
                // 鄰居是不透明實體 → 不渲染
                if (!TRANSPARENT.has(nbId)) continue;
                // 鄰居是不同種類的透明 block (如樹葉旁邊的水) → 渲染
            }

            // ── 特例：水面只渲染頂面 ──────────────────────────
            // 這樣水面看起來像平面，不會在水中看到側面
            if (blockId === 4 && !(dir[0] === 0 && dir[1] === 1 && dir[2] === 0)) {
                // 只有在緊鄰陸地的側面才渲染（讓海岸邊緣可見）
                if (nbId === 0) {
                    // 鄰居是空氣（水面側邊對著岸邊），渲染
                } else {
                    continue; // 水下側面，不渲染
                }
            }

            const px = cx * CHUNK_SIZE + lx - 0.5;
            const py = cy * CHUNK_SIZE + ly - 0.5;
            const pz = cz * CHUNK_SIZE + lz - 0.5;

            for (const pos of corners) {
                data.positions.push(px + pos[0], py + pos[1], pz + pos[2]);
                data.normals.push(...dir);
            }
            data.uvs.push(0,1, 0,0, 1,0, 1,1);
            data.indices.push(
                data.ndx, data.ndx+1, data.ndx+2,
                data.ndx, data.ndx+2, data.ndx+3
            );
            data.ndx += 4;
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

    finalizeBuffer('grass', 1);
    finalizeBuffer('log',   2);
    finalizeBuffer('leaves',3);
    finalizeBuffer('water', 4);
    finalizeBuffer('sand',  5);

    (self as unknown as Worker).postMessage(response, transferList);
};
