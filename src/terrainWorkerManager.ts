export class TerrainWorkerManager {
    worker: Worker;
    callbacks: Map<number, (data: any) => void>;
    nextId: number = 0;

    constructor() {
        this.worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
        this.callbacks = new Map();
        
        this.worker.onmessage = (e) => {
            const { id } = e.data;
            const cb = this.callbacks.get(id);
            if (cb) {
                cb(e.data);
                this.callbacks.delete(id);
            }
        };

        this.worker.onerror = (err) => {
            console.error("Terrain worker threw an error:", err);
        };
    }

    requestChunk(cx: number, cy: number, cz: number): Promise<any> {
        return new Promise(resolve => {
            const id = this.nextId++;
            this.callbacks.set(id, resolve);
            this.worker.postMessage({ id, cx, cy, cz });
        });
    }

    setBlock(x: number, y: number, z: number, type: number) {
        this.worker.postMessage({ action: 'setBlock', x, y, z, type });
    }
}

export const terrainWorkerManager = new TerrainWorkerManager();
