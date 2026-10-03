import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import type { Background } from '../app/project';
import { layer } from './layers';

/** The traced map image lying on the ground under the roads. */
export class BackgroundView {
  readonly group = new Group();
  private mesh: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  private src: string | null = null;
  private readonly loader = new TextureLoader();

  constructor(private readonly maxAnisotropy: number) {}

  set(bg: Background | null): void {
    if (bg === null) {
      this.clear();
      return;
    }
    if (bg.src !== this.src) {
      this.clear();
      this.src = bg.src;
      const texture = this.loader.load(bg.src);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.maxAnisotropy;
      this.mesh = this.makeMesh(texture);
      this.group.add(this.mesh);
    }
    const m = this.mesh;
    if (m === null) throw new Error('Background mesh missing after load');
    m.scale.set(bg.width * bg.metersPerPixel, bg.height * bg.metersPerPixel, 1);
    m.position.set(bg.x, 0.012, bg.y);
    m.rotation.set(-Math.PI / 2, 0, -bg.rotation);
    m.material.opacity = bg.opacity;
  }

  private makeMesh(texture: Texture): Mesh<PlaneGeometry, MeshBasicMaterial> {
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, ...layer('map') });
    return new Mesh(new PlaneGeometry(1, 1), material);
  }

  private clear(): void {
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.map?.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = null;
    this.src = null;
  }
}
