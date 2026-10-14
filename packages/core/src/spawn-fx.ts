import * as THREE from 'three';

/**
 * 欢乐的生成特效（Spawn FX）：
 * 1. 弹性形变（Squash & Stretch / Elastic Pop）：
 *    物体出现时伴随充满弹性的形变与微跳，像果冻或卡通玩具一样Duang~地落地弹跳。
 * 2. 欢快纸屑/星星粒子爆裂（Poof / Confetti Burst）：
 *    在生成点瞬间喷射出一圈轻盈旋转的小纸屑/彩色星星粒子，伴随重力向外散开并缩放淡出。
 */

interface MeshBounce {
  obj: THREE.Object3D;
  time: number;
  duration: number;
  initialScale: THREE.Vector3;
  initialY: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotSpeed: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
}

export class SpawnFx {
  private readonly group = new THREE.Group();
  private readonly bounces: MeshBounce[] = [];
  private readonly particles: Particle[] = [];

  // 共享几何体和材质，极大节省资源与 Draw Calls
  private starGeo: THREE.BufferGeometry | null = null;
  private particleMats: THREE.MeshBasicMaterial[] = [];

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'spawn-fx';
    this.scene.add(this.group);
    this.initParticleAssets();
  }

  private initParticleAssets() {
    // 制作一个可爱的 4 角/5 角星形（低多面体、轻量）
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

    // 几组色彩明亮活泼的糖果色材质（纸屑/星星）
    const colors = [
      '#ffcc00', // 金黄
      '#ff5e7e', // 樱桃粉
      '#4dd2ff', // 天空蓝
      '#a259ff', // 梦幻紫
      '#52ea7d', // 薄荷绿
      '#ff9900', // 甜橙
    ];
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
  }

  /**
   * 触发生成动画：
   * @param targetObj 要弹跳的 Three.js 对象（可选，若只需粒子特效可不传）
   * @param worldPos 粒子喷射的世界坐标（可选，若传了 targetObj 且未传 worldPos，则自动取 targetObj 的世界坐标）
   */
  trigger(targetObj?: THREE.Object3D | null, worldPos?: THREE.Vector3 | [number, number, number]) {
    let burstOrigin: THREE.Vector3 | null = null;

    if (worldPos) {
      burstOrigin = Array.isArray(worldPos)
        ? new THREE.Vector3(...worldPos)
        : worldPos.clone();
    } else if (targetObj) {
      targetObj.updateWorldMatrix(true, false);
      burstOrigin = targetObj.getWorldPosition(new THREE.Vector3());
    }

    // 1. 启动网格果冻弹性弹出动画
    if (targetObj) {
      // 检查是否已有针对该物体的动画，有则重置
      const existing = this.bounces.find(b => b.obj === targetObj);
      if (existing) {
        existing.obj.scale.copy(existing.initialScale);
        existing.obj.position.y = existing.initialY;
        existing.time = 0;
      } else {
        const initialScale = targetObj.scale.clone();
        const initialY = targetObj.position.y;
        this.bounces.push({
          obj: targetObj,
          time: 0,
          duration: 0.52,
          initialScale,
          initialY,
        });
        // 初始帧压扁缩放，准备向上弹跃
        targetObj.scale.set(initialScale.x * 0.1, initialScale.y * 0.1, initialScale.z * 0.1);
      }
    }

    // 2. 喷射彩色星星粒子
    if (burstOrigin && this.starGeo && this.particleMats.length) {
      const count = 12 + Math.floor(Math.random() * 5); // 12 ~ 16 个粒子
      for (let i = 0; i < count; i++) {
        const mat = this.particleMats[Math.floor(Math.random() * this.particleMats.length)];
        const mesh = new THREE.Mesh(this.starGeo, mat.clone()); // 独立 clone 材质控制独立 opacity

        // 初始位置在物体底部略微向上一点
        mesh.position.copy(burstOrigin);
        mesh.position.y += 0.15;

        // 沿半球方向向外喷射
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * (Math.PI * 0.38) + 0.1; // 向上偏斜
        const speed = 2.4 + Math.random() * 2.8;

        const vel = new THREE.Vector3(
          Math.cos(theta) * Math.sin(phi) * speed,
          Math.cos(phi) * speed + 1.2, // 额外向上升力
          Math.sin(theta) * Math.sin(phi) * speed
        );

        const rotSpeed = new THREE.Vector3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12
        );

        const baseScale = 0.7 + Math.random() * 0.6;
        mesh.scale.setScalar(baseScale * 0.2); // 从小变大再淡出

        this.group.add(mesh);

        this.particles.push({
          mesh,
          vel,
          rotSpeed,
          life: 0,
          maxLife: 0.45 + Math.random() * 0.25, // 0.45 ~ 0.7 秒
          baseScale,
        });
      }
    }
  }

  /**
   * 推进一帧动画
   * @param dt 逝去秒数
   * @returns boolean 是否仍有动画在进行（用于触发视图重绘）
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
        // 弹性阻尼衰减震荡公式
        // 表现为先快速展开并拉长，再下落砸下压扁，然后回弹归位
        const decay = Math.exp(-p * 6);
        const osc = Math.sin(p * Math.PI * 3.5);

        // Y 轴拉伸/压扁
        const scaleY = 1 + osc * decay * 0.55;
        // X/Z 轴体积守恒式反向形变
        const scaleXZ = 1 - osc * decay * 0.3;

        // 起步阶段有额外的快速放大插值 (0 -> 1)
        const entrance = Math.min(1, p * 4.5);

        b.obj.scale.set(
          b.initialScale.x * scaleXZ * entrance,
          b.initialScale.y * scaleY * entrance,
          b.initialScale.z * scaleXZ * entrance
        );

        // 伴随微小的弹跳离地高度 (小跳落地)
        const hop = Math.max(0, Math.sin(p * Math.PI) * (1 - p) * 0.45);
        b.obj.position.y = b.initialY + hop;
      }
    }

    // 2. 更新粒子喷射与旋转
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
        // 物理位移
        pt.vel.y += gravity * dt;
        pt.mesh.position.addScaledVector(pt.vel, dt);

        // 翻滚旋转
        pt.mesh.rotation.x += pt.rotSpeed.x * dt;
        pt.mesh.rotation.y += pt.rotSpeed.y * dt;
        pt.mesh.rotation.z += pt.rotSpeed.z * dt;

        // 缩放与透明度变化：前 20% 快速变大，后 80% 逐渐缩紧并淡出
        const scaleFactor = progress < 0.2
          ? (progress / 0.2)
          : Math.max(0, 1 - (progress - 0.2) / 0.8);
        pt.mesh.scale.setScalar(pt.baseScale * scaleFactor);

        const mat = pt.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 1 - Math.pow(progress, 1.8));
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

    for (const pt of this.particles) {
      this.group.remove(pt.mesh);
      (pt.mesh.material as THREE.Material).dispose();
    }
    this.particles.length = 0;

    if (this.starGeo) {
      this.starGeo.dispose();
      this.starGeo = null;
    }
    for (const m of this.particleMats) m.dispose();
    this.particleMats.length = 0;

    this.group.removeFromParent();
  }
}
