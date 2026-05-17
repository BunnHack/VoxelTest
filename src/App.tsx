import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import * as THREE from 'three';
import { CHUNK_SIZE, RENDER_DISTANCE, getTerrainSurfaceHeight, getBlock, getBaseHeight } from './utils';
import { terrainWorkerManager } from './terrainWorkerManager';
import { raycast } from './voxelRaycaster';
import { setBlockMain, chunkEvents } from './playerActions';
import { world, playerEntity, Position, Velocity, PlayerState } from './ecs';
import GUI from 'lil-gui';

// --- State and Handlers ---

export const controlState = {
  move: { x: 0, y: 0 },
  look: { yaw: 0, pitch: -0.3 }, // start looking slightly down
  jump: false,
  spectatorMove: { up: false, down: false }
};

export const gameSettings = {
  spectatorMode: false,
  showCaveEntrances: false
};


function TouchLookArea() {
  const pointerDown = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
        if (document.pointerLockElement) {
            controlState.look.yaw -= e.movementX * 0.002;
            controlState.look.pitch -= e.movementY * 0.002;
        }
    };
    document.addEventListener('mousemove', onMouseMove);
    return () => document.removeEventListener('mousemove', onMouseMove);
  }, []);

  return (
    <div 
      className="absolute inset-0 z-10 touch-none pointer-events-auto"
      onClick={(e) => {
          const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
          if (!isMobile && !document.pointerLockElement) {
              e.currentTarget.requestPointerLock();
          }
      }}
      // Context menu prevent default so right click for placing blocks doesn't open the browser context menu
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        pointerDown.current = true;
        lastPos.current = { x: e.clientX, y: e.clientY };
        const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
        if (isMobile) {
            e.currentTarget.setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (document.pointerLockElement) return; // handled by global event listener
        if (!pointerDown.current) return;
        const dx = e.clientX - lastPos.current.x;
        const dy = e.clientY - lastPos.current.y;
        lastPos.current = { x: e.clientX, y: e.clientY };
        
        // Adjust sensitivity here
        controlState.look.yaw -= dx * 0.005;
        controlState.look.pitch -= dy * 0.005;
      }}
      onPointerUp={(e) => {
        pointerDown.current = false;
        const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
        if (isMobile) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={(e) => {
        pointerDown.current = false;
      }}
    />
  );
}

export function VirtualJoystick() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const baseRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const startDrag = (clientX: number, clientY: number) => {
    dragging.current = true;
    updatePos(clientX, clientY);
  };

  const updatePos = (clientX: number, clientY: number) => {
    if (!dragging.current || !baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    
    const max = Math.min(rect.width, rect.height) / 2;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > max) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    
    setPos({ x: dx, y: dy });
    controlState.move.x = dx / max;
    controlState.move.y = dy / max; // positive is backward
  };

  const endDrag = () => {
    dragging.current = false;
    setPos({ x: 0, y: 0 });
    controlState.move.x = 0;
    controlState.move.y = 0;
  };

  return (
    <div 
      className="absolute bottom-12 left-12 w-32 h-32 bg-black/20 backdrop-blur-md rounded-full border-2 border-white/30 touch-none flex items-center justify-center p-4 z-20 cursor-pointer"
      ref={baseRef}
      onPointerDown={(e) => {
        e.stopPropagation(); // prevent looking when dragging joystick
        e.currentTarget.setPointerCapture(e.pointerId);
        startDrag(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        updatePos(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        e.currentTarget.releasePointerCapture(e.pointerId);
        endDrag();
      }}
      onPointerCancel={(e) => {
        e.stopPropagation();
        endDrag();
      }}
    >
      <div 
        className="w-14 h-14 bg-white/90 rounded-full shadow-lg"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      />
    </div>
  );
}

// --- 3D Scene Components ---

function Player() {
  const { camera, gl } = useThree();
  const direction = useRef(new THREE.Vector3());
  
  useEffect(() => {
    // Search from sky downwards for the first solid block at X=0, Z=0
    let spawnY = 60;
    for (let y = 60; y >= -30; y--) {
        if (getBlock(0, y, 0) !== 0 && getBlock(0, y + 1, 0) === 0) {
            spawnY = y;
            break;
        }
    }
    
    // 初始化 ECS 的玩家狀態
    Position.x[playerEntity] = 0;
    Position.y[playerEntity] = spawnY + 2.12; // Top of block is 0.5, eye height is ~1.62
    Position.z[playerEntity] = 0;
    Velocity.x[playerEntity] = 0;
    Velocity.y[playerEntity] = 0;
    Velocity.z[playerEntity] = 0;
    
    camera.rotation.order = 'YXZ'; // Important for FPS camera math
  }, [camera]);

  useEffect(() => {
    const performInteraction = (type: 'break' | 'place') => {
      const rayDir = new THREE.Vector3();
      camera.getWorldDirection(rayDir);
      
      const res = raycast(camera.position, rayDir, 6);
      if (res.hit && res.voxel && res.prev) {
        if (type === 'break') {
           setBlockMain(res.voxel.x, res.voxel.y, res.voxel.z, 0); 
        } else if (type === 'place') {
           setBlockMain(res.prev.x, res.prev.y, res.prev.z, 2); // 2 = log
        }
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      // If we are on mobile, we probably don't have pointer lock. 
      // If we are on desktop and don't have pointer lock, the click should be used to acquire it, not to place a block.
      const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
      if (!isMobile && !document.pointerLockElement) {
         // The click on TouchLookArea will request pointer lock. Let's not break/place.
         return;
      }
      
      // Ignore clicks on UI buttons
      if (e.target instanceof Element && e.target.closest('button')) {
          return;
      }
      
      if (e.button === 0) performInteraction('break');
      if (e.button === 2) performInteraction('place');
    };
    
    const onTouchInteract = (e: Event) => {
        const type = (e as CustomEvent).detail;
        if (type === 'break' || type === 'place') {
            performInteraction(type);
        }
    };

    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('player-interact', onTouchInteract);
    return () => {
        document.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('player-interact', onTouchInteract);
    };
  }, [camera]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1); // clamp delta
  
    // Clamp pitch (up/down look) to avoid flipping over
    controlState.look.pitch = Math.max(-Math.PI/2 + 0.05, Math.min(Math.PI/2 - 0.05, controlState.look.pitch));
    
    // Apply looking angles to the camera
    camera.rotation.set(controlState.look.pitch, controlState.look.yaw, 0);
    
    // Player speed in blocks (meters) per second
    const isFeetInWaterMovement = getBlock(Math.floor(Position.x[playerEntity]), Math.floor(Position.y[playerEntity] - 1.62), Math.floor(Position.z[playerEntity])) === 4;
    const isHeadInWaterMovement = getBlock(Math.floor(Position.x[playerEntity]), Math.floor(Position.y[playerEntity] + 0.1), Math.floor(Position.z[playerEntity])) === 4;
    const inWaterMovement = isFeetInWaterMovement || isHeadInWaterMovement;

    const speed = gameSettings.spectatorMode ? 25.0 : (inWaterMovement ? 3.5 : 7.0);
    
    // Direction based on joystick X and Y
    direction.current.set(controlState.move.x, 0, controlState.move.y);
    if (direction.current.lengthSq() > 1) {
        direction.current.normalize();
    }
    
    // Rotate the movement vector to match where the player is currently looking (yaw)
    direction.current.applyEuler(new THREE.Euler(0, controlState.look.yaw, 0));
    
    // Apply velocity to position
    const oldPosition = new THREE.Vector3(Position.x[playerEntity], Position.y[playerEntity], Position.z[playerEntity]);
    
    // Apply velocity for horizontal movement
    Velocity.x[playerEntity] = direction.current.x * speed;
    Velocity.z[playerEntity] = direction.current.z * speed;
    
    const PLAYER_RADIUS = 0.3;
    const PLAYER_HEIGHT = 1.6;
    const EPSILON = 0.001;

    const checkAABB = (dx: number, dy: number, dz: number) => {
        if (gameSettings.spectatorMode) return false;
        
        const x = Position.x[playerEntity] + dx;
        const feetY = Position.y[playerEntity] + dy - 1.62;
        const z = Position.z[playerEntity] + dz;

        const minX = Math.floor(x - PLAYER_RADIUS + 0.5 + EPSILON);
        const maxX = Math.floor(x + PLAYER_RADIUS + 0.5 - EPSILON);
        const minY = Math.floor(feetY + 0.5 + EPSILON);
        const maxY = Math.floor(feetY + PLAYER_HEIGHT + 0.5 - EPSILON);
        const minZ = Math.floor(z - PLAYER_RADIUS + 0.5 + EPSILON);
        const maxZ = Math.floor(z + PLAYER_RADIUS + 0.5 - EPSILON);

        for (let bx = minX; bx <= maxX; bx++) {
            for (let by = minY; by <= maxY; by++) {
                for (let bz = minZ; bz <= maxZ; bz++) {
                    const block = getBlock(bx, by, bz);
                    if (block !== 0 && block !== 4) return true;
                }
            }
        }
        return false;
    };
    
    // Check X collision
    let tempX = Velocity.x[playerEntity] * dt;
    if (checkAABB(tempX, 0, 0)) {
        Velocity.x[playerEntity] = 0;
    } else {
        Position.x[playerEntity] += tempX;
    }

    // Check Z collision
    let tempZ = Velocity.z[playerEntity] * dt;
    if (checkAABB(0, 0, tempZ)) {
        Velocity.z[playerEntity] = 0;
    } else {
        Position.z[playerEntity] += tempZ;
    }
    
    // Apply Gravity and Vertical Velocity
    const isFeetInWater = getBlock(Math.floor(Position.x[playerEntity]), Math.floor(Position.y[playerEntity] - 1.62), Math.floor(Position.z[playerEntity])) === 4;
    const isHeadInWater = getBlock(Math.floor(Position.x[playerEntity]), Math.floor(Position.y[playerEntity] + 0.1), Math.floor(Position.z[playerEntity])) === 4;
    const inWater = isFeetInWater || isHeadInWater;

    if (gameSettings.spectatorMode) {
        // Vertical spectator movement
        Velocity.y[playerEntity] = 0;
        if (controlState.spectatorMove.up) Velocity.y[playerEntity] = speed;
        if (controlState.spectatorMove.down) Velocity.y[playerEntity] = -speed;
        Position.y[playerEntity] += Velocity.y[playerEntity] * dt;
        
        // Also allow looking directly where moving vertically if they point camera up/down
        const yDir = -Math.sin(controlState.look.pitch); // if looking down, goes down
        // Optional: incorporate pitch into forward speed but we keep it simple with Space/Shift
    } else {
        const GRAVITY = inWater ? 5 : 25;
        const JUMP_FORCE = 8.5;
        const terminalVelocity = inWater ? -3 : -30;
        
        Velocity.y[playerEntity] -= GRAVITY * dt;
        if (inWater && Velocity.y[playerEntity] < terminalVelocity) {
            Velocity.y[playerEntity] += 20 * dt; // Decelerate in water
            if (Velocity.y[playerEntity] > terminalVelocity) Velocity.y[playerEntity] = terminalVelocity;
        } else if (!inWater && Velocity.y[playerEntity] < terminalVelocity) {
            Velocity.y[playerEntity] = terminalVelocity;
        }

        if (inWater && controlState.jump) {
            Velocity.y[playerEntity] += 15 * dt;
            if (Velocity.y[playerEntity] > 4) Velocity.y[playerEntity] = 4;
        }
        
        let tempY = Velocity.y[playerEntity] * dt;

        // Vertical Collision
        if (Velocity.y[playerEntity] <= 0 && checkAABB(0, tempY, 0)) {
            // Hit ground
            Velocity.y[playerEntity] = 0;
            const targetFeetY = Position.y[playerEntity] + tempY - 1.62;
            const hitBlockY = Math.floor(targetFeetY + 0.5 - EPSILON);
            Position.y[playerEntity] = hitBlockY + 0.5 + 1.62;
            
            if (controlState.jump && !inWater) {
                Velocity.y[playerEntity] = JUMP_FORCE;
            }
        } else if (Velocity.y[playerEntity] > 0 && checkAABB(0, tempY, 0)) {
            // Hit ceiling
            Velocity.y[playerEntity] = 0;
            const targetHeadY = Position.y[playerEntity] + tempY - 1.62 + PLAYER_HEIGHT;
            const hitBlockY = Math.floor(targetHeadY + 0.5 + EPSILON);
            Position.y[playerEntity] = hitBlockY - 0.5 - PLAYER_HEIGHT + 1.62;
        } else {
            Position.y[playerEntity] += tempY;
        }
    }

    // Sync back to camera
    camera.position.set(Position.x[playerEntity], Position.y[playerEntity], Position.z[playerEntity]);
  });

  return null;
}

const useGameMaterials = () => {
    return useMemo(() => {
        const createTex = (drawCb: (ctx: CanvasRenderingContext2D) => void) => {
            const canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
            const ctx = canvas.getContext('2d');
            if (ctx) drawCb(ctx);
            const tex = new THREE.CanvasTexture(canvas);
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.needsUpdate = true;
            return tex;
        };

        const grassTex = createTex(ctx => {
            ctx.fillStyle = '#5c9e3b';
            ctx.fillRect(0, 0, 16, 16);
            for(let i=0; i<80; i++){
                ctx.fillStyle = Math.random() > 0.5 ? '#4b822f' : '#6bb845';
                ctx.fillRect(Math.floor(Math.random()*16), Math.floor(Math.random()*16), 1, 1);
            }
        });

        const logTex = createTex(ctx => {
            ctx.fillStyle = '#6b4d32';
            ctx.fillRect(0, 0, 16, 16);
            for(let i=0; i<100; i++){
                ctx.fillStyle = Math.random() > 0.5 ? '#563c26' : '#7f5e3e';
                ctx.fillRect(Math.floor(Math.random()*16), Math.floor(Math.random()*16), 1, Math.floor(Math.random()*4 + 1));
            }
        });

        const leavesTex = createTex(ctx => {
            ctx.fillStyle = '#3a6626';
            ctx.fillRect(0, 0, 16, 16);
            for(let i=0; i<120; i++){
                ctx.fillStyle = Math.random() > 0.5 ? '#2d521d' : '#498530';
                ctx.fillRect(Math.floor(Math.random()*16), Math.floor(Math.random()*16), 1, 1);
            }
            for(let i=0; i<30; i++){
                ctx.clearRect(Math.floor(Math.random()*16), Math.floor(Math.random()*16), 1, 1);
            }
        });

        const waterTex = createTex(ctx => {
            ctx.fillStyle = 'rgba(40, 100, 200, 0.8)';
            ctx.fillRect(0, 0, 16, 16);
            ctx.fillStyle = 'rgba(60, 120, 220, 0.8)';
            for(let i=0; i<30; i++){
                ctx.fillRect(Math.floor(Math.random()*16), Math.floor(Math.random()*16), 2, 1);
            }
        });

        const sandTex = createTex(ctx => {
            ctx.fillStyle = '#d9c47a';
            ctx.fillRect(0, 0, 16, 16);
            for (let i = 0; i < 60; i++) {
                ctx.fillStyle = Math.random() > 0.5 ? '#c8b468' : '#e8d488';
                ctx.fillRect(Math.floor(Math.random()*16), Math.floor(Math.random()*16), 1, 1);
            }
        });

        return {
            grass: new THREE.MeshLambertMaterial({ map: grassTex }),
            log: new THREE.MeshLambertMaterial({ map: logTex }),
            leaves: new THREE.MeshLambertMaterial({ map: leavesTex, transparent: true, alphaTest: 0.1 }),
            water: new THREE.MeshLambertMaterial({ map: waterTex, transparent: true, opacity: 0.8, alphaTest: 0.01, depthWrite: false, color: "#aaddff" }),
            sand: new THREE.MeshLambertMaterial({ map: sandTex })
        };
    }, []);
};

function SunLight() {
  const { camera } = useThree();
  const lightRef = useRef<THREE.DirectionalLight>(null);

  useFrame(() => {
    if (lightRef.current) {
      lightRef.current.position.set(camera.position.x + 20, 40, camera.position.z + 10);
      lightRef.current.target.position.set(camera.position.x, 0, camera.position.z);
      lightRef.current.target.updateMatrixWorld();
    }
  });

  return (
    <directionalLight
      ref={lightRef}
      intensity={1.2}
    />
  );
}

function ChunkMesh({ cx, cy, cz, materials }: { cx: number; cy: number; cz: number; materials: any }) {
    const [geometries, setGeometries] = useState<{ grass: THREE.BufferGeometry, log: THREE.BufferGeometry, leaves: THREE.BufferGeometry, water: THREE.BufferGeometry, sand: THREE.BufferGeometry } | null>(null);
    const [rev, setRev] = useState(0);

    useEffect(() => {
        const key = `${cx},${cy},${cz}`;
        const onUpdate = () => setRev(r => r + 1);
        chunkEvents.addEventListener(key, onUpdate);
        return () => chunkEvents.removeEventListener(key, onUpdate);
    }, [cx, cy, cz]);
    
    useEffect(() => {
        let isCancelled = false;
        
        terrainWorkerManager.requestChunk(cx, cy, cz).then((data) => {
            if (isCancelled) return;
            if (data.isEmpty) {
                setGeometries(null);
                return;
            }
            
            const createGeo = (geoData: any) => {
                if (!geoData) return null;
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(geoData.positions), 3));
                geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(geoData.normals), 3));
                geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geoData.uvs), 2));
                geo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(geoData.indices), 1));
                geo.computeBoundingSphere();
                return geo;
            };

            setGeometries({
                grass: createGeo(data.grass) as THREE.BufferGeometry,
                log: createGeo(data.log) as THREE.BufferGeometry,
                leaves: createGeo(data.leaves) as THREE.BufferGeometry,
                water: createGeo(data.water) as THREE.BufferGeometry,
                sand: createGeo(data.sand) as THREE.BufferGeometry,
            });
        });

        return () => {
            isCancelled = true;
        }
    }, [cx, cy, cz, rev]);

    useEffect(() => {
        return () => {
            if (geometries) {
                if (geometries.grass) geometries.grass.dispose();
                if (geometries.log) geometries.log.dispose();
                if (geometries.leaves) geometries.leaves.dispose();
                if (geometries.water) geometries.water.dispose();
                if (geometries.sand) geometries.sand.dispose();
            }
        };
    }, [geometries]);

    if (!geometries) return null; // loading

    return (
        <group>
            {geometries.grass && (
                <mesh geometry={geometries.grass} material={materials.grass} frustumCulled={true} />
            )}
            {geometries.sand && (
                <mesh geometry={geometries.sand} material={materials.sand} frustumCulled={true} />
            )}
            {geometries.log && (
                <mesh geometry={geometries.log} material={materials.log} frustumCulled={true} />
            )}
            {geometries.leaves && (
                <mesh geometry={geometries.leaves} material={materials.leaves} frustumCulled={true} />
            )}
            {geometries.water && (
                <mesh geometry={geometries.water} material={materials.water} frustumCulled={true} />
            )}
        </group>
    );
}

function Chunk({ x, y, z, materials }: { x: number; y: number; z: number; materials: any }) {
    return <ChunkMesh cx={x} cy={y} cz={z} materials={materials} />;
}

function Terrain() {
  const materials = useGameMaterials();

  const [chunks, setChunks] = useState<{ x: number; y: number; z: number }[]>([]);
  const lastPos = useRef({ cx: Infinity, cy: Infinity, cz: Infinity });

  useFrame(({ camera }) => {
    const cx = Math.floor(camera.position.x / CHUNK_SIZE);
    const cy = Math.floor(camera.position.y / CHUNK_SIZE);
    const cz = Math.floor(camera.position.z / CHUNK_SIZE);

    if (cx !== lastPos.current.cx || cy !== lastPos.current.cy || cz !== lastPos.current.cz) {
      lastPos.current = { cx, cy, cz };
      const newChunks = [];
      for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
        for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
            for (let dy = -2; dy <= 2; dy++) {
                newChunks.push({ x: cx + dx, y: cy + dy, z: cz + dz });
            }
        }
      }
      setChunks(newChunks);
    }
  });

  return (
    <group>
      {chunks.map((c) => (
        <Chunk key={`${c.x},${c.y},${c.z}`} x={c.x} y={c.y} z={c.z} materials={materials} />
      ))}
    </group>
  );
}

function CaveEntranceHighlighter() {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const [entrances, setEntrances] = useState<THREE.Vector3[]>([]);
    
    useEffect(() => {
        if (!gameSettings.showCaveEntrances) {
            setEntrances([]);
            return;
        }

        const interval = setInterval(() => {
            if (!gameSettings.showCaveEntrances) return;

            const px = Math.floor(Position.x[playerEntity]);
            const pz = Math.floor(Position.z[playerEntity]);
            
            const found: THREE.Vector3[] = [];
            const radius = 48; // scan radius
            
            // simple scan
            for (let dx = -radius; dx <= radius; dx += 2) {
                for (let dz = -radius; dz <= radius; dz += 2) {
                    const wx = px + dx;
                    const wz = pz + dz;
                    
                    const bh = Math.floor(getBaseHeight(wx, wz));
                    
                    // A cave entrance is where the block at baseHeight is air
                    // and it goes deeper (e.g. bh-1 is also air)
                    const blockSurface = getBlock(wx, bh, wz);
                    const blockBelow1 = getBlock(wx, bh - 1, wz);
                    const blockBelow2 = getBlock(wx, bh - 2, wz);
                    const blockBelow3 = getBlock(wx, bh - 3, wz);
                    const blockBelow4 = getBlock(wx, bh - 4, wz);

                    if (blockSurface === 0 && blockBelow1 === 0 && (blockBelow2 === 0 || blockBelow3 === 0 || blockBelow4 === 0)) {
                        found.push(new THREE.Vector3(wx, bh, wz));
                    }
                }
            }
            if (found.length > 0) {
                console.log(`Found ${found.length} cave entrances`, found);
            }
            setEntrances(found);
        }, 1000);

        return () => clearInterval(interval);
    }, [gameSettings.showCaveEntrances]);

    useEffect(() => {
        if (meshRef.current) {
            const dummy = new THREE.Object3D();
            entrances.forEach((pos, i) => {
                dummy.position.copy(pos);
                dummy.updateMatrix();
                meshRef.current!.setMatrixAt(i, dummy.matrix);
            });
            meshRef.current.count = entrances.length;
            meshRef.current.instanceMatrix.needsUpdate = true;
        }
    }, [entrances]);

    if (!gameSettings.showCaveEntrances || entrances.length === 0) return null;

    return (
        <instancedMesh ref={meshRef} args={[undefined, undefined, 2000]} frustumCulled={false}>
            <boxGeometry args={[1.1, 8.1, 1.1]} />
            <meshBasicMaterial color="#ff00ff" wireframe transparent opacity={0.8} />
        </instancedMesh>
    );
}

function CoordinateOverlay() {
    const coordsRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let handle: number;
        const updateCoords = () => {
            if (coordsRef.current) {
                const x = Position.x[playerEntity].toFixed(1);
                const y = Position.y[playerEntity].toFixed(1);
                const z = Position.z[playerEntity].toFixed(1);
                coordsRef.current.innerText = `X: ${x} Y: ${y} Z: ${z}`;
            }
            handle = requestAnimationFrame(updateCoords);
        };
        handle = requestAnimationFrame(updateCoords);
        return () => cancelAnimationFrame(handle);
    }, []);

    return (
        <div 
            ref={coordsRef}
            className="absolute top-4 left-4 text-white font-mono bg-black/50 p-2 rounded z-50 pointer-events-none"
        >
            X: 0.0 Y: 0.0 Z: 0.0
        </div>
    );
}

export default function App() {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const gui = new GUI();
    gui.add(gameSettings, 'spectatorMode').name('Spectator Mode').onChange(() => {
      forceRender(x => x + 1);
    });
    gui.add(gameSettings, 'showCaveEntrances').name('Show Cave Entrances').onChange(() => {
      forceRender(x => x + 1); // Trigger React re-render when this changes
    });
    return () => {
      gui.destroy();
    };
  }, []);

  useEffect(() => {
     const onKeyDown = (e: KeyboardEvent) => {
         switch (e.code) {
             case 'KeyW': controlState.move.y = -1; break;
             case 'KeyS': controlState.move.y = 1; break;
             case 'KeyA': controlState.move.x = -1; break;
             case 'KeyD': controlState.move.x = 1; break;
             case 'Space': 
               controlState.jump = true; 
               controlState.spectatorMove.up = true;
               break;
             case 'ShiftLeft':
               controlState.spectatorMove.down = true;
               break;
         }
     };
     const onKeyUp = (e: KeyboardEvent) => {
         switch (e.code) {
             case 'KeyW':
             case 'KeyS': if ((e.code === 'KeyW' && controlState.move.y < 0) || (e.code === 'KeyS' && controlState.move.y > 0)) controlState.move.y = 0; break;
             case 'KeyA':
             case 'KeyD': if ((e.code === 'KeyA' && controlState.move.x < 0) || (e.code === 'KeyD' && controlState.move.x > 0)) controlState.move.x = 0; break;
             case 'Space': 
               controlState.jump = false; 
               controlState.spectatorMove.up = false;
               break;
             case 'ShiftLeft':
               controlState.spectatorMove.down = false;
               break;
         }
     };
     window.addEventListener('keydown', onKeyDown);
     window.addEventListener('keyup', onKeyUp);
     return () => {
         window.removeEventListener('keydown', onKeyDown);
         window.removeEventListener('keyup', onKeyUp);
     }
  }, []);

  return (
    <div className="w-screen h-screen bg-sky-200 overflow-hidden relative">
      <CoordinateOverlay />
      <div className="absolute top-20 left-4 z-30 bg-black/60 border-2 border-zinc-500 backdrop-blur-sm px-4 py-2 shadow-sm select-none pointer-events-none font-mono text-white">
        <h1 className="font-bold mb-1">Minecraft Baseplate</h1>
        <p className="text-xs text-zinc-300">
            <strong>Desktop:</strong> WASD to move. Click to lock pointer. Left click break, Right click place.<br/>
            <strong>Mobile:</strong> Left joystick to move. Drag background to look.
        </p>
      </div>

      <VirtualJoystick />
      <TouchLookArea />

      {/* Mobile Interaction Hooks */}
      <div 
        className="absolute right-8 bottom-8 z-40 flex flex-col gap-4 pointer-events-none"
        style={{ display: (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ? 'flex' : 'none' }}
      >
         <button 
           className="w-16 h-16 rounded-full bg-black/40 border-2 border-white/20 text-white font-bold backdrop-blur-md pointer-events-auto active:bg-white/30"
           onPointerDown={(e) => {
               e.stopPropagation();
               controlState.jump = true;
               controlState.spectatorMove.up = true;
           }}
           onPointerUp={(e) => {
               e.stopPropagation();
               controlState.jump = false;
               controlState.spectatorMove.up = false;
           }}
           onPointerCancel={(e) => {
               controlState.jump = false;
               controlState.spectatorMove.up = false;
           }}
         >
           Jump
         </button>
         {gameSettings.spectatorMode && (
           <button 
             className="w-16 h-16 rounded-full bg-black/40 border-2 border-white/20 text-white font-bold backdrop-blur-md pointer-events-auto active:bg-white/30"
             onPointerDown={(e) => {
                 e.stopPropagation();
                 controlState.spectatorMove.down = true;
             }}
             onPointerUp={(e) => {
                 e.stopPropagation();
                 controlState.spectatorMove.down = false;
             }}
             onPointerCancel={(e) => {
                 controlState.spectatorMove.down = false;
             }}
           >
             Down
           </button>
         )}
         <button 
           className="w-16 h-16 rounded-full bg-black/40 border-2 border-white/20 text-white font-bold backdrop-blur-md pointer-events-auto active:bg-white/30"
           onPointerDown={(e) => {
               e.stopPropagation();
               window.dispatchEvent(new CustomEvent('player-interact', { detail: 'place' }));
           }}
         >
           Place
         </button>
         <button 
           className="w-16 h-16 rounded-full bg-black/40 border-2 border-white/20 text-white font-bold backdrop-blur-md pointer-events-auto active:bg-white/30"
           onPointerDown={(e) => {
               e.stopPropagation();
               window.dispatchEvent(new CustomEvent('player-interact', { detail: 'break' }));
           }}
         >
           Break
         </button>
      </div>

      <div className="absolute inset-0 z-0 pointer-events-none">
        {/* FPS Crosshair */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 text-white/70 z-20 pointer-events-none mix-blend-difference flex items-center justify-center">
            <div className="w-full h-[2px] bg-white absolute"></div>
            <div className="h-full w-[2px] bg-white absolute"></div>
        </div>
        
        <Canvas shadows camera={{ fov: 80 }}>
          <fog attach="fog" args={['#87CEEB', 20, 60]} />
          <ambientLight intensity={0.6} />
          
          <SunLight />
          <Sky sunPosition={[20, 60, 10]} turbidity={0.1} rayleigh={0.5} />
          
          <Terrain />
          <Player />
          <CaveEntranceHighlighter />
        </Canvas>
      </div>
    </div>
  );
}
