import { createWorld, addEntity, addComponent, query } from 'bitecs';

// 建立 ECS World
export const world = createWorld();

// 定義組件 (Components) - 底層使用 TypedArray，CPU cache 友好且無 GC 壓力
// In bitECS 0.4.0, components are flat arrays/objects
export const Position = { x: new Float32Array(1000), y: new Float32Array(1000), z: new Float32Array(1000) };
export const Velocity = { x: new Float32Array(1000), y: new Float32Array(1000), z: new Float32Array(1000) };
export const PlayerState = { isGrounded: new Uint8Array(1000) };

// 初始化一個玩家實體，加入到 ECS 中
export const playerEntity = addEntity(world);
addComponent(world, playerEntity, Position);
addComponent(world, playerEntity, Velocity);
addComponent(world, playerEntity, PlayerState);


