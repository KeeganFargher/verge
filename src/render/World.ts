import {
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PlaneGeometry,
  Scene,
  type WebGLRenderer,
} from 'three';
import { CameraRig } from './CameraRig';
import { palette } from './palette';

/** The 3D scene: ground, sky, light, and the layers the views draw into. */
export class World {
  readonly scene = new Scene();
  readonly rig: CameraRig;
  readonly background = new Group();
  readonly network = new Group();
  readonly vehicles = new Group();
  readonly overlay = new Group();
  readonly labels = new Group();
  readonly grid: GridHelper;
  private readonly sun: DirectionalLight;

  constructor(renderer: WebGLRenderer, aspect: number) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    this.rig = new CameraRig(aspect);
    this.scene.background = new Color(palette.sky);
    this.scene.fog = new Fog(palette.sky, 2500, 9000);

    const hemi = new HemisphereLight(palette.skyLight, palette.groundLight, 1.6);
    this.scene.add(hemi);
    this.sun = new DirectionalLight(0xfff4e5, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.4;
    this.scene.add(this.sun, this.sun.target);

    const ground = new Mesh(
      new PlaneGeometry(20000, 20000),
      new MeshStandardMaterial({ color: palette.ground, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.grid = new GridHelper(4000, 400, palette.gridMajor, palette.gridMinor);
    this.grid.position.y = 0.02;
    const gridMaterial = this.grid.material;
    if (Array.isArray(gridMaterial)) throw new Error('GridHelper is expected to have a single material');
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.18;
    gridMaterial.depthWrite = false;
    this.scene.add(this.grid);

    this.scene.add(this.background, this.network, this.vehicles, this.overlay, this.labels);
  }

  update(dt: number): void {
    this.rig.update(dt);
    // Keep the shadow frustum around what the camera looks at, sized to the zoom level.
    const t = this.rig.target;
    const extent = Math.min(1500, Math.max(60, this.rig.distance * 0.9));
    this.sun.position.set(t.x + extent * 0.6, extent * 1.4, t.z + extent * 0.35);
    this.sun.target.position.copy(t);
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = extent * 4;
    cam.updateProjectionMatrix();
  }

  resize(aspect: number): void {
    this.rig.resize(aspect);
  }
}
