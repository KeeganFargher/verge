import { MathUtils, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';

/**
 * City-builder camera: orbits a target point on the ground. Pans by grabbing the ground (the
 * point under the cursor stays under the cursor), zooms towards the cursor, rotates and tilts.
 * Goal values are eased towards so wheel and keyboard input feel smooth.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  /** Point on the ground the camera orbits (world x/z; y is always 0). */
  readonly target = new Vector3();
  distance = 420;
  yaw = 0;
  /** Elevation angle above the horizon (rad). */
  pitch = 0.95;

  private readonly goalTarget = new Vector3();
  private goalDistance = 420;
  private goalYaw = 0;
  private goalPitch = 0.95;
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private readonly raycaster = new Raycaster();

  static readonly MIN_DISTANCE = 12;
  static readonly MAX_DISTANCE = 4000;
  static readonly MIN_PITCH = 0.35;
  static readonly MAX_PITCH = 1.5;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(45, aspect, 1, 20000);
    this.apply();
  }

  setGoal(x: number, z: number, distance: number, yaw = this.goalYaw, pitch = this.goalPitch): void {
    this.goalTarget.set(x, 0, z);
    this.goalDistance = MathUtils.clamp(distance, CameraRig.MIN_DISTANCE, CameraRig.MAX_DISTANCE);
    this.goalYaw = yaw;
    this.goalPitch = MathUtils.clamp(pitch, CameraRig.MIN_PITCH, CameraRig.MAX_PITCH);
  }

  /** Jumps straight to the goal (used when loading a network). */
  snap(): void {
    this.target.copy(this.goalTarget);
    this.distance = this.goalDistance;
    this.yaw = this.goalYaw;
    this.pitch = this.goalPitch;
    this.apply();
  }

  /** Point on the ground under a screen position in normalised device coordinates, or null for the sky. */
  groundAt(ndc: Vector2, out = new Vector3()): Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this.ground, out);
  }

  /** Moves target and goal together by a world-space offset (direct manipulation, no easing). */
  shift(dx: number, dz: number): void {
    const limit = 6000;
    this.target.x = MathUtils.clamp(this.target.x + dx, -limit, limit);
    this.target.z = MathUtils.clamp(this.target.z + dz, -limit, limit);
    this.goalTarget.copy(this.target);
    this.apply();
  }

  /** Pans relative to the view direction (keyboard), scaled by zoom so it feels the same at any height. */
  panView(forward: number, right: number): void {
    const s = this.goalDistance;
    const fx = -Math.sin(this.goalYaw);
    const fz = -Math.cos(this.goalYaw);
    this.goalTarget.x += (fx * forward + -fz * right) * s;
    this.goalTarget.z += (fz * forward + fx * right) * s;
  }

  rotate(dYaw: number, dPitch: number): void {
    this.goalYaw += dYaw;
    this.goalPitch = MathUtils.clamp(this.goalPitch + dPitch, CameraRig.MIN_PITCH, CameraRig.MAX_PITCH);
  }

  /** Zooms by a factor, pulling the target towards `towards` so the point under the cursor stays put. */
  zoom(factor: number, towards: Vector3 | null): void {
    const next = MathUtils.clamp(this.goalDistance * factor, CameraRig.MIN_DISTANCE, CameraRig.MAX_DISTANCE);
    const actual = next / this.goalDistance;
    if (towards !== null) {
      this.goalTarget.x += (towards.x - this.goalTarget.x) * (1 - actual);
      this.goalTarget.z += (towards.z - this.goalTarget.z) * (1 - actual);
    }
    this.goalDistance = next;
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 12);
    this.target.lerp(this.goalTarget, k);
    this.distance += (this.goalDistance - this.distance) * k;
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.apply();
  }

  private apply(): void {
    const c = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * c * this.distance,
      Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * c * this.distance,
    );
    this.camera.lookAt(this.target);
    // Picking happens between frames; it needs the matrices of this pose, not the last render's.
    this.camera.updateMatrixWorld();
    // Tight near/far range for depth precision: road markings sit centimetres above the asphalt.
    this.camera.near = Math.max(0.5, this.distance * 0.02);
    this.camera.far = this.distance * 12 + 2000;
    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
