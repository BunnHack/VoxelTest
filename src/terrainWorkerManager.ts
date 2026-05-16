export class TerrainWorkerManager {
    workers: Worker[];
    callbacks: Map<number, (data: any) => void>;
    nextId: number = 0;
    currentWorkerIndex: number = 0;

    constructor() {
        this.callbacks = new Map();
        
        const WORKER_COUNT = navigator.hardwareConcurrency 
            ? Math.min(navigator.hardwareConcurrency - 1, 4) 
            : 2;
        
        this.workers = [];
        for (let i = 0; i < Math.max(1, WORKER_COUNT); i++) {
            const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
            
            worker.onmessage = (e) => {
                const { id } = e.data;
                const cb = this.callbacks.get(id);
                if (cb) {
                    cb(e.data);
                    this.callbacks.delete(id);
                }
            };

            worker.onerror = (err) => {
                console.error("Terrain worker threw an error:", err);
            };
            
            this.workers.push(worker);
        }
    }

    requestChunk(cx: number, cy: number, cz: number): Promise<any> {
        return new Promise(resolve => {
            const id = this.nextId++;
            this.callbacks.set(id, resolve);
            
            const worker = this.workers[this.currentWorkerIndex];
            this.currentWorkerIndex = (this.currentWorkerIndex + 1) % this.workers.length;
            
            worker.postMessage({ id, cx, cy, cz });
        });
    }

    setBlock(x: number, y: number, z: number, type: number) {
        for (const worker of this.workers) {
            worker.postMessage({ action: 'setBlock', x, y, z, type });
        }
    }
}

export const terrainWorkerManager = new TerrainWorkerManager();
