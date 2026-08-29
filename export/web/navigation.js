/**
 * Runtime navigation for the baked Hijacked Detour mesh.
 *
 * This module intentionally imports the Recast packages instead of baking in
 * the browser. Static deployments need an import map (or a bundler) for
 * three, @recast-navigation/core, @recast-navigation/three, and
 * @recast-navigation/wasm. See .tools/bake_navmesh.mjs for the offline bake.
 */

import * as THREE from 'three';
import { Crowd, importNavMesh, init, NavMeshQuery } from '@recast-navigation/core';
import { CrowdHelper, DebugDrawer } from '@recast-navigation/three';

export const DEFAULT_NAVMESH_URL = 'hijacked.navmesh.bin';
export const DEFAULT_QUERY_HALF_EXTENTS = Object.freeze({ x: 48, y: 128, z: 48 });
export const DEFAULT_AGENT_PARAMS = Object.freeze({
  radius: 16,
  height: 72,
  maxAcceleration: 200,
  maxSpeed: 320,
  collisionQueryRange: 64,
  pathOptimizationRange: 96,
  separationWeight: 2,
  updateFlags: 7,
  obstacleAvoidanceType: 0,
  queryFilterType: 0,
});

let recastInitialization;

/** Initialize the WASM module once for all navigation instances. */
export function initializeNavigationWasm() {
  recastInitialization ??= init();
  return recastInitialization;
}

function asVector3(value, label = 'position') {
  if (value instanceof THREE.Vector3) return value;
  if (Array.isArray(value) && value.length >= 3) return new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]));
  if (value && typeof value === 'object' && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)) && Number.isFinite(Number(value.z))) {
    return new THREE.Vector3(Number(value.x), Number(value.y), Number(value.z));
  }
  throw new TypeError(`${label} must be a THREE.Vector3, [x,y,z], or {x,y,z}`);
}

function plainVector3(value) {
  return { x: value.x, y: value.y, z: value.z };
}

async function readNavMeshBytes(source, fetchImpl) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (typeof Response !== 'undefined' && source instanceof Response) return new Uint8Array(await source.arrayBuffer());
  if (source && typeof source.arrayBuffer === 'function') return new Uint8Array(await source.arrayBuffer());
  if (typeof source !== 'string') throw new TypeError('navmesh source must be a URL, Response, ArrayBuffer, or Uint8Array');
  const response = await (fetchImpl ?? fetch)(source);
  if (!response.ok) throw new Error(`failed to load navmesh ${source}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Load a serialized navmesh and return query/path/crowd helpers.
 *
 * options.maxAgents > 0 enables an optional Detour Crowd. No agents are
 * spawned implicitly: call addAgent() so game code controls their spawns.
 * Set options.debug=true to create a DebugDrawer and draw the navmesh.
 */
export async function loadNavigation(sourceOrOptions = DEFAULT_NAVMESH_URL, maybeOptions = {}) {
  const isOptionsObject = sourceOrOptions && typeof sourceOrOptions === 'object' &&
    !(sourceOrOptions instanceof ArrayBuffer) && !ArrayBuffer.isView(sourceOrOptions) &&
    typeof sourceOrOptions.arrayBuffer !== 'function' && typeof sourceOrOptions !== 'string';
  const source = isOptionsObject ? (sourceOrOptions.source ?? DEFAULT_NAVMESH_URL) : sourceOrOptions;
  const options = isOptionsObject ? sourceOrOptions : maybeOptions;
  await initializeNavigationWasm();
  const bytes = await readNavMeshBytes(source, options.fetch);
  const { navMesh } = importNavMesh(bytes);
  const query = new NavMeshQuery(navMesh, { maxNodes: options.maxNodes ?? 4096 });
  query.defaultQueryHalfExtents = {
    ...DEFAULT_QUERY_HALF_EXTENTS,
    ...(options.queryHalfExtents ?? {}),
  };

  const maxAgents = Math.max(0, Math.floor(options.maxAgents ?? 0));
  const maxAgentRadius = Number(options.maxAgentRadius ?? DEFAULT_AGENT_PARAMS.radius);
  const crowd = maxAgents > 0 ? new Crowd(navMesh, { maxAgents, maxAgentRadius }) : null;
  const debugDrawer = options.debug || options.debugDrawer ? new DebugDrawer(options.debugDrawerParams) : null;
  if (debugDrawer) {
    debugDrawer.drawNavMesh(navMesh, options.debugFlags ?? 0xffff);
    debugDrawer.visible = options.debug !== false;
  }
  const crowdHelper = crowd && options.debugCrowd ? new CrowdHelper(crowd, options.debugCrowdParams) : null;

  const projectPoint = (position, projectOptions = {}) => {
    const input = asVector3(position);
    const result = query.findClosestPoint(plainVector3(input), {
      filter: projectOptions.filter,
      halfExtents: projectOptions.halfExtents ?? query.defaultQueryHalfExtents,
    });
    return {
      ...result,
      point: result.success ? new THREE.Vector3(result.point.x, result.point.y, result.point.z) : null,
      input,
    };
  };

  const findNearest = (position, findOptions = {}) => {
    const input = asVector3(position);
    const result = query.findNearestPoly(plainVector3(input), {
      filter: findOptions.filter,
      halfExtents: findOptions.halfExtents ?? query.defaultQueryHalfExtents,
    });
    return {
      ...result,
      nearestPoint: result.success ? new THREE.Vector3(result.nearestPoint.x, result.nearestPoint.y, result.nearestPoint.z) : null,
      input,
    };
  };

  const findPath = (start, end, pathOptions = {}) => {
    const result = query.computePath(plainVector3(asVector3(start, 'start')), plainVector3(asVector3(end, 'end')), {
      ...pathOptions,
      halfExtents: pathOptions.halfExtents ?? query.defaultQueryHalfExtents,
    });
    return {
      ...result,
      path: result.path.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
    };
  };

  /** Constrain a desired player move to the walkable navmesh surface. */
  const constrainMovement = (current, desired, moveOptions = {}) => {
    const from = asVector3(current, 'current');
    const to = asVector3(desired, 'desired');
    const nearest = findNearest(from, moveOptions);
    if (!nearest.success || !nearest.nearestRef) return { success: false, position: from.clone(), nearest };
    const result = query.moveAlongSurface(nearest.nearestRef, plainVector3(from), plainVector3(to), {
      filter: moveOptions.filter,
      maxVisitedSize: moveOptions.maxVisitedSize,
    });
    return {
      ...result,
      position: result.success ? new THREE.Vector3(result.resultPosition.x, result.resultPosition.y, result.resultPosition.z) : from.clone(),
      nearest,
    };
  };

  const addAgent = (position, agentOptions = {}) => {
    if (!crowd) throw new Error('Crowd is disabled; pass maxAgents > 0 to loadNavigation');
    const projected = projectPoint(position, agentOptions);
    if (!projected.success || !projected.point) throw new Error('cannot spawn crowd agent outside the navmesh');
    const { filter: _filter, halfExtents: _halfExtents, ...crowdOptions } = agentOptions;
    return crowd.addAgent(plainVector3(projected.point), {
      ...DEFAULT_AGENT_PARAMS,
      ...crowdOptions,
    });
  };

  const update = (dt, timeSinceLastCalled, maxSubSteps) => {
    if (crowd) {
      crowd.update(dt, timeSinceLastCalled, maxSubSteps);
      crowdHelper?.update();
    }
  };

  const setDebugVisible = (visible) => {
    if (debugDrawer) debugDrawer.visible = Boolean(visible);
    if (crowdHelper) crowdHelper.visible = Boolean(visible);
  };

  const dispose = () => {
    debugDrawer?.dispose();
    crowd?.destroy();
    query.destroy();
    navMesh.destroy();
  };

  return {
    bytes,
    navMesh,
    query,
    crowd,
    debugDrawer,
    crowdHelper,
    projectPoint,
    findNearest,
    findPath,
    constrainMovement,
    addAgent,
    update,
    setDebugVisible,
    dispose,
  };
}

export { asVector3 };

