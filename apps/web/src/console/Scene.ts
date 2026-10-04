import * as THREE from 'three';
import { qRot, type RenderFrame, type Scenario } from '@wingmind/shared';
import type { Terrain } from '@wingmind/sim-core';

// Out-the-window view (implementation 8.1): Three.js on WebGL2 at display rate,
// procedural terrain from the same height grid the sim uses. ENU maps to Three's
// Y-up frame as (east, up, -north).

const toThree = (v: readonly number[]): THREE.Vector3 => new THREE.Vector3(v[0]!, v[2]!, -v[1]!);

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 16 / 9, 5, 120_000);
  private markers = new Map<string, THREE.Object3D>();
  private markerGeo: Record<string, THREE.BufferGeometry> = {};
  private markerMat: Record<string, THREE.Material> = {};
  private world = new THREE.Group();
  pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  readonly ok: boolean;

  constructor(private container: HTMLElement) {
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    } catch {
      renderer = null;
    }
    this.ok = renderer !== null;
    this.renderer = renderer ?? (null as unknown as THREE.WebGLRenderer);
    if (!renderer) return;
    renderer.setPixelRatio(this.pixelRatio);
    renderer.domElement.setAttribute('data-testid', 'scene');
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);
    this.scene.background = new THREE.Color('#7fa7c9');
    this.scene.fog = new THREE.Fog('#9db9d2', 8_000, 70_000);
    this.scene.add(new THREE.HemisphereLight('#dfefff', '#3a3424', 1.1));
    const sun = new THREE.DirectionalLight('#fff4dd', 1.4);
    sun.position.set(0.5, 1, 0.3);
    this.scene.add(sun);
    this.markerGeo = {
      fighter: new THREE.ConeGeometry(12, 40, 6).rotateX(-Math.PI / 2),
      missile: new THREE.CylinderGeometry(2, 2, 18, 6).rotateX(Math.PI / 2),
      drone: new THREE.BoxGeometry(8, 3, 8),
      sam: new THREE.BoxGeometry(30, 12, 30),
      shorad: new THREE.BoxGeometry(14, 8, 14),
      chaff: new THREE.SphereGeometry(10, 6, 4),
      flare: new THREE.SphereGeometry(4, 6, 4),
    };
    this.markerMat = {
      red: new THREE.MeshBasicMaterial({ color: '#ff5566' }),
      flare: new THREE.MeshBasicMaterial({ color: '#fff3b0' }),
      chaff: new THREE.MeshBasicMaterial({ color: '#cccccc', transparent: true, opacity: 0.4 }),
    };
  }

  /** Build a terrain mesh at reduced resolution (at most ~256 x 256 vertices). */
  setTerrain(t: Terrain, scenario: Scenario): void {
    if (!this.ok) return;
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    const step = Math.max(1, Math.ceil(Math.max(t.nx, t.ny) / 256));
    const nx = Math.floor((t.nx - 1) / step) + 1, ny = Math.floor((t.ny - 1) / step) + 1;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    const c = new THREE.Color();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const gi = Math.min(t.nx - 1, i * step), gj = Math.min(t.ny - 1, j * step);
      const h = t.heights[gj * t.nx + gi]!;
      const x = t.x0 + gi * t.spacing, y = t.y0 + gj * t.spacing;
      const k = (j * nx + i) * 3;
      pos[k] = x; pos[k + 1] = h; pos[k + 2] = -y;
      const f = Math.min(1, h / Math.max(t.maxM, 1));
      c.setHSL(0.27 - f * 0.18, 0.35 - f * 0.15, 0.22 + f * 0.35);
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.world.add(mesh);
    // cloud layers as translucent sheets
    for (const cl of scenario.weather.clouds) {
      const [xmin, ymin, xmax, ymax] = t.spec.bounds;
      const sheet = new THREE.Mesh(
        new THREE.PlaneGeometry(xmax - xmin + 60_000, ymax - ymin + 60_000).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#f4f6f8', transparent: true, opacity: 0.35 * cl.cover, depthWrite: false, side: THREE.DoubleSide }),
      );
      sheet.position.set((xmin + xmax) / 2, cl.baseFt * 0.3048, -(ymin + ymax) / 2);
      this.world.add(sheet);
    }
  }

  draw(f: RenderFrame): void {
    if (!this.ok) return;
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h || this.renderer.getPixelRatio() !== this.pixelRatio) {
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const o = f.own;
    this.camera.position.copy(toThree(o.pos));
    // camera axes from the body frame: right = -left, up = up, back = -forward
    const fwd = toThree(qRot(o.att, [1, 0, 0]));
    const left = toThree(qRot(o.att, [0, 1, 0]));
    const up = toThree(qRot(o.att, [0, 0, 1]));
    const m = new THREE.Matrix4().makeBasis(left.multiplyScalar(-1), up, fwd.multiplyScalar(-1));
    this.camera.quaternion.setFromRotationMatrix(m);

    const seen = new Set<string>();
    for (const e of f.entities) {
      if (!e.alive) continue;
      seen.add(e.id);
      let obj = this.markers.get(e.id);
      if (!obj) {
        const geo = this.markerGeo[e.type] ?? this.markerGeo.drone!;
        const mat = e.type === 'flare' ? this.markerMat.flare! : e.type === 'chaff' ? this.markerMat.chaff! : this.markerMat.red!;
        obj = new THREE.Mesh(geo, mat);
        this.markers.set(e.id, obj);
        this.scene.add(obj);
      }
      obj.position.copy(toThree(e.pos));
      obj.rotation.set(0, (-e.headingDeg * Math.PI) / 180, 0);
      // keep distant markers visible by scaling with range
      const d = obj.position.distanceTo(this.camera.position);
      obj.scale.setScalar(Math.max(1, d / 3000));
    }
    for (const [id, obj] of this.markers) {
      if (!seen.has(id)) { this.scene.remove(obj); this.markers.delete(id); }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (!this.ok) return;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
