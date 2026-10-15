// three-mesh-bvh's BVH worker ships untyped
declare module "three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js" {
  export class GenerateMeshBVHWorker {
    generate(...args: unknown[]): Promise<unknown>;
    dispose(): void;
  }
}
