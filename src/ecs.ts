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

// 你可以在這裡掛載更多 ECS 系統 (Systems)
// 比如 movementSystem 會在每一幀執行
export const movementSystem = (worldToUpdate: any, dt: number) => {
    // queries in v0.4.0 use query(world, [components])
    const ents = query(worldToUpdate, [Position, Velocity]);
    for (let i = 0; i < ents.length; i++) {
        const eid = ents[i];
        // 基本的 ECS 移動邏輯，如果有自定義的重力 / 碰撞系統，可以另外實作
        // Position.x[eid] += Velocity.x[eid] * dt;
        // Position.y[eid] += Velocity.y[eid] * dt;
        // Position.z[eid] += Velocity.z[eid] * dt;
    }
    return worldToUpdate;
};
