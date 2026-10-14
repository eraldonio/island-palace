import * as THREE from 'three';

/**
 * 欢乐物理与生成特效系统（Spawn & Physics FX）：
 * 1. 落地重量感与撞击弹性（Impact & Weight / Squash & Stretch）：
 *    - 当物体被放下/放置/生成时，不仅弹跳，更伴随重量冲击带来的横向挤压膨胀与下沉反弹（Thud / Thump）。
 *    - 落地时从接触边缘激发向外扩散的物理冲击尘环（Dust Ring Puff）与重物微小烟尘粒子。
 * 2. 欢快纸屑/星星粒子爆裂（Confetti / Star Burst）：
 *    - 在新生成物件时喷射。
 * 3. 拖曳倾斜与重量感惯性（Drag Tilt & Inertia）：
 *    - 在移动拖曳物体时，物体会随移动速度和方向产生自然的物理倾角与悬挂摆动（Inertial Tilt）。
 */

interface MeshBounce {
  obj: THREE.Object3D;
  time: number;
  duration: number;
  initialScale: THREE.Vector3;
  initialY: number;
  squashFactor: number;
  hopHeight: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotSpeed: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
  fadePow: number;
}

interface RingPuff {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  startScale: number;
  targetScale: number;
}

export class SpawnFx {
  private readonly group = new THREE.Group();
  private readonly bounces: MeshBounce[] = [];
  private readonly particles: Particle[] = [];
  private readonly rings: RingPuff[] = [];

  // 共享几何体和材质，极大节省资源与 Draw Calls
  private starGeo: THREE.BufferGeometry | null = null;
  private ringGeo: THREE.BufferGeometry | null = null;
  private dustGeo: THREE.BufferGeometry | null = null;
  private particleMats: THREE.MeshBasicMaterial[] = [];
  private dustMats: THREE.MeshBasicMaterial[] = [];
  private ringMat: THREE.MeshBasicMaterial | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'spawn-fx';
    this.scene.add(this.group);
    this.initAssets();
  }

  private initAssets() {
    // 1. 星形几何体（用于生成时的纸屑/星星）
    const shape = new THREE.Shape();
    const points = 5;
    const outerR = 0.16;
    const innerR = 0.07;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const angle = (i * Math.PI) / points - Math.PI / 2;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    this.starGeo = new THREE.ShapeGeometry(shape);

    // 2. 冲击波圆环（用于重物落地冲击波）
    this.ringGeo = new THREE.RingGeometry(0.3, 0.42, 24);
    this.ringGeo.rotateX(-Math.PI / 2); // 贴在地面上
    this.ringMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // 3. 落地烟尘微球（用于重量冲击时扬起的小灰尘）
    this.dustGeo = new THREE.IcosahedronGeometry(0.12, 1);

    // 彩色糖果色材质（纸屑/星星）
    const colors = ['#ffcc00', '#ff5e7e', '#4dd2ff', '#a259ff', '#52ea7d', '#ff9900'];
    this.particleMats = colors.map(
      c =>
        new THREE.MeshBasicMaterial({
          color: c,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 1,
          depthWrite: false,
        })
    );

    // 柔和白/土色微尘材质
    const dustColors = ['#f5efe6', '#ebe1d2', '#ded4c3'];
    this.dustMats = dustColors.map(
      c =>
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
        })
    );
  }

  /**
   * 触发生成动画（兼具弹性形变 + 欢快星星粒子）
   */
  trigger(targetObj?: THREE.Object3D | null, worldPos?: THREE.Vector3 | [number, number, number]) {
    let burstOrigin: THREE.Vector3 | null = null;
    if (worldPos) {
      burstOrigin = Array.isArray(worldPos) ? new THREE.Vector3(...worldPos) : worldPos.clone();
    } else if (targetObj) {
      targetObj.updateWorldMatrix(true, false);
      burstOrigin = targetObj.getWorldPosition(new THREE.Vector3());
    }

    // 1. 弹性形变
    if (targetObj) {
      this.playBounce(targetObj, {
        duration: 0.52,
        initialScaleFactor: 0.1,
        squashFactor: 0.55,
        hopHeight: 0.45,
      });
    }

    // 2. 喷射彩色星星粒子
    if (burstOrigin && this.starGeo && this.particleMats.length) {
      const count = 12 + Math.floor(Math.random() * 5);
      for (let i = 0; i < count; i++) {
        const mat = this.particleMats[Math.floor(Math.random() * this.particleMats.length)];
        const mesh = new THREE.Mesh(this.starGeo, mat.clone());
        mesh.position.copy(burstOrigin);
        mesh.position.y += 0.15;

        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * (Math.PI * 0.38) + 0.1;
        const speed = 2.4 + Math.random() * 2.8;

        const vel = new THREE.Vector3(
          Math.cos(theta) * Math.sin(phi) * speed,
          Math.cos(phi) * speed + 1.2,
          Math.sin(theta) * Math.sin(phi) * speed
        );

        const rotSpeed = new THREE.Vector3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12
        );

        const baseScale = 0.7 + Math.random() * 0.6;
        mesh.scale.setScalar(baseScale * 0.2);

        this.group.add(mesh);

        this.particles.push({
          mesh,
          vel,
          rotSpeed,
          life: 0,
          maxLife: 0.45 + Math.random() * 0.25,
          baseScale,
          fadePow: 1.8,
        });
      }
    }
  }

  /**
   * 触发重物放下/着陆撞击感（Thud / Drop Impact）：
   * 沉甸甸的向下挤压压扁，再伴随弹性阻尼回弹，并在地面扬起一圈冲击尘圈。
   */
  dropImpact(targetObj?: THREE.Object3D | null, worldPos?: THREE.Vector3 | [number, number, number], weightScale = 1.0) {
    let hitOrigin: THREE.Vector3 | null = null;
    if (worldPos) {
      hitOrigin = Array.isArray(worldPos) ? new THREE.Vector3(...worldPos) : worldPos.clone();
    } else if (targetObj) {
      targetObj.updateWorldMatrix(true, false);
      hitOrigin = targetObj.getWorldPosition(new THREE.Vector3());
    }

    if (targetObj) {
      // 沉重有力的重击挤压反弹：向下挤压多、弹跳幅度小而厚重
      this.playBounce(targetObj, {
        duration: 0.38,
        initialScaleFactor: 1.0, // 原尺寸开始受力压缩
        squashFactor: 0.35 * Math.min(1.8, weightScale),
        hopHeight: 0.15 * Math.min(1.5, weightScale),
      });
    }

    // 激发地面冲击波圆环（Shockwave ring puff）
    if (hitOrigin && this.ringGeo && this.ringMat) {
      const ringMesh = new THREE.Mesh(this.ringGeo, this.ringMat.clone());
      ringMesh.position.copy(hitOrigin);
      ringMesh.position.y += 0.02; // 稍高于地面防穿透
      const radius = 0.8 * Math.max(0.6, Math.min(2.0, weightScale));
      ringMesh.scale.setScalar(0.2);
      this.group.add(ringMesh);

      this.rings.push({
        mesh: ringMesh,
        life: 0,
        maxLife: 0.32,
        startScale: 0.3,
        targetScale: radius * 2.2,
      });

      // 扬起 6~8 个细小灰尘小球向四周散开
      if (this.dustGeo && this.dustMats.length) {
        const dustCount = 6 + Math.floor(Math.random() * 4);
        for (let i = 0; i < dustCount; i++) {
          const mat = this.dustMats[Math.floor(Math.random() * this.dustMats.length)];
          const mesh = new THREE.Mesh(this.dustGeo, mat.clone());
          mesh.position.copy(hitOrigin);
          mesh.position.y += 0.06;

          const angle = (i / dustCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
          const speed = 1.2 + Math.random() * 1.5;
          const vel = new THREE.Vector3(
            Math.cos(angle) * speed,
            0.6 + Math.random() * 1.0, // 低低地抛起
            Math.sin(angle) * speed
          );

          mesh.scale.setScalar(0.4 + Math.random() * 0.3);
          this.group.add(mesh);

          this.particles.push({
            mesh,
            vel,
            rotSpeed: new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4),
            life: 0,
            maxLife: 0.28 + Math.random() * 0.18,
            baseScale: 0.5,
            fadePow: 1.2,
          });
        }
      }
    }
  }

  private playBounce(
    targetObj: THREE.Object3D,
    opts: { duration: number; initialScaleFactor: number; squashFactor: number; hopHeight: number }
  ) {
    const existing = this.bounces.find(b => b.obj === targetObj);
    if (existing) {
      existing.obj.scale.copy(existing.initialScale);
      existing.obj.position.y = existing.initialY;
      existing.time = 0;
      existing.duration = opts.duration;
      existing.squashFactor = opts.squashFactor;
      existing.hopHeight = opts.hopHeight;
    } else {
      const initialScale = targetObj.scale.clone();
      const initialY = targetObj.position.y;
      this.bounces.push({
        obj: targetObj,
        time: 0,
        duration: opts.duration,
        initialScale,
        initialY,
        squashFactor: opts.squashFactor,
        hopHeight: opts.hopHeight,
      });
      if (opts.initialScaleFactor < 1.0) {
        targetObj.scale.set(
          initialScale.x * opts.initialScaleFactor,
          initialScale.y * opts.initialScaleFactor,
          initialScale.z * opts.initialScaleFactor
        );
      }
    }
  }

  /**
   * 推进一帧动画
   */
  update(dt: number): boolean {
    let active = false;

    // 1. 更新物体弹性动画
    for (let i = this.bounces.length - 1; i >= 0; i--) {
      const b = this.bounces[i];
      b.time += dt;
      const p = Math.min(1, b.time / b.duration);

      if (p >= 1) {
        b.obj.scale.copy(b.initialScale);
        b.obj.position.y = b.initialY;
        this.bounces.splice(i, 1);
      } else {
        active = true;
        const decay = Math.exp(-p * 7);
        const osc = Math.sin(p * Math.PI * 3.5);

        // Y 轴拉伸/压扁
        const scaleY = 1 + osc * decay * b.squashFactor;
        // X/Z 轴体积守恒式反向形变
        const scaleXZ = 1 - osc * decay * (b.squashFactor * 0.55);

        const entrance = Math.min(1, p * 4.5);

        b.obj.scale.set(
          b.initialScale.x * scaleXZ * entrance,
          b.initialScale.y * scaleY * entrance,
          b.initialScale.z * scaleXZ * entrance
        );

        // 落地小弹跳离地高度
        const hop = Math.max(0, Math.sin(p * Math.PI) * (1 - p) * b.hopHeight);
        b.obj.position.y = b.initialY + hop;
      }
    }

    // 2. 更新冲击波圆环（Rings）
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const rg = this.rings[i];
      rg.life += dt;
      const progress = rg.life / rg.maxLife;

      if (progress >= 1) {
        this.group.remove(rg.mesh);
        (rg.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      } else {
        active = true;
        // 缓动扩大
        const easeOut = 1 - Math.pow(1 - progress, 2.5);
        const curScale = rg.startScale + (rg.targetScale - rg.startScale) * easeOut;
        rg.mesh.scale.setScalar(curScale);

        const mat = rg.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = (1 - progress) * 0.65;
      }
    }

    // 3. 更新粒子喷射与旋转
    const gravity = -11.0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life += dt;
      const progress = pt.life / pt.maxLife;

      if (progress >= 1) {
        this.group.remove(pt.mesh);
        (pt.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      } else {
        active = true;
        pt.vel.y += gravity * dt;
        pt.mesh.position.addScaledVector(pt.vel, dt);

        pt.mesh.rotation.x += pt.rotSpeed.x * dt;
        pt.mesh.rotation.y += pt.rotSpeed.y * dt;
        pt.mesh.rotation.z += pt.rotSpeed.z * dt;

        const scaleFactor = progress < 0.2
          ? (progress / 0.2)
          : Math.max(0, 1 - (progress - 0.2) / 0.8);
        pt.mesh.scale.setScalar(pt.baseScale * scaleFactor);

        const mat = pt.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 1 - Math.pow(progress, pt.fadePow));
      }
    }

    return active;
  }

  dispose() {
    for (const b of this.bounces) {
      b.obj.scale.copy(b.initialScale);
      b.obj.position.y = b.initialY;
    }
    this.bounces.length = 0;

    for (const rg of this.rings) {
      this.group.remove(rg.mesh);
      (rg.mesh.material as THREE.Material).dispose();
    }
    this.rings.length = 0;

    for (const pt of this.particles) {
      this.group.remove(pt.mesh);
      (pt.mesh.material as THREE.Material).dispose();
    }
    this.particles.length = 0;

    if (this.starGeo) {
      this.starGeo.dispose();
      this.starGeo = null;
    }
    if (this.ringGeo) {
      this.ringGeo.dispose();
      this.ringGeo = null;
    }
    if (this.dustGeo) {
      this.dustGeo.dispose();
      this.dustGeo = null;
    }
    if (this.ringMat) {
      this.ringMat.dispose();
      this.ringMat = null;
    }
    for (const m of this.particleMats) m.dispose();
    this.particleMats.length = 0;
    for (const m of this.dustMats) m.dispose();
    this.dustMats.length = 0;

    this.group.removeFromParent();
  }
}
