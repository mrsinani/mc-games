import Matter from "matter-js";
import { ballFrictionsByRowCount } from "./constants";
import type { RowCount } from "./types";

export interface BallLandEvent {
  ballId: number;
  binIndex: number;
}

export interface PlinkoEngineOptions {
  canvas: HTMLCanvasElement;
  rowCount: RowCount;
  onBallLand: (event: BallLandEvent) => void;
}

const WIDTH = 760;
const HEIGHT = 570;
const PADDING_X = 52;
const PADDING_TOP = 36;
const PADDING_BOTTOM = 28;
const PIN_CATEGORY = 0x0001;
const BALL_CATEGORY = 0x0002;

export default class PlinkoEngine {
  private canvas: HTMLCanvasElement;
  private rowCount: RowCount;
  private onBallLand: (event: BallLandEvent) => void;

  private engine: Matter.Engine;
  private render: Matter.Render;
  private runner: Matter.Runner;

  private pins: Matter.Body[] = [];
  private walls: Matter.Body[] = [];
  private sensor: Matter.Body;
  private pinsLastRowXCoords: number[] = [];

  constructor(options: PlinkoEngineOptions) {
    this.canvas = options.canvas;
    this.rowCount = options.rowCount;
    this.onBallLand = options.onBallLand;

    this.engine = Matter.Engine.create({ timing: { timeScale: 2 } });
    this.render = Matter.Render.create({
      engine: this.engine,
      canvas: this.canvas,
      options: {
        width: WIDTH,
        height: HEIGHT,
        background: "#0f1728",
        wireframes: false,
      },
    });
    this.runner = Matter.Runner.create();

    this.placePinsAndWalls();

    this.sensor = Matter.Bodies.rectangle(WIDTH / 2, HEIGHT, WIDTH, 10, {
      isSensor: true,
      isStatic: true,
      render: { visible: false },
    });
    Matter.Composite.add(this.engine.world, [this.sensor]);

    Matter.Events.on(this.engine, "collisionStart", ({ pairs }) => {
      for (const { bodyA, bodyB } of pairs) {
        if (bodyA === this.sensor) this.handleBallEnterBin(bodyB);
        else if (bodyB === this.sensor) this.handleBallEnterBin(bodyA);
      }
    });
  }

  start() {
    Matter.Render.run(this.render);
    Matter.Runner.run(this.runner, this.engine);
  }

  stop() {
    Matter.Render.stop(this.render);
    Matter.Runner.stop(this.runner);
  }

  destroy() {
    this.stop();
    Matter.Engine.clear(this.engine);
  }

  dropBall(): number {
    const ballRadius = this.pinRadius * 2;

    const jitter = (Math.random() - 0.5) * this.pinDistanceX * 0.3;
    const startX = Math.max(
      PADDING_X + ballRadius,
      Math.min(WIDTH - PADDING_X - ballRadius, WIDTH / 2 + jitter),
    );

    const ball = Matter.Bodies.circle(startX, 0, ballRadius, {
      restitution: 0.8,
      friction: 0.5,
      frictionAir: ballFrictionsByRowCount[this.rowCount],
      collisionFilter: {
        category: BALL_CATEGORY,
        mask: PIN_CATEGORY,
      },
      render: { fillStyle: "#ff0000" },
    });
    Matter.Composite.add(this.engine.world, ball);
    return ball.id;
  }

  updateRowCount(newRowCount: RowCount) {
    if (newRowCount === this.rowCount) return;
    this.removeAllBalls();
    this.rowCount = newRowCount;
    this.placePinsAndWalls();
  }

  get binsWidthPercentage(): number {
    if (this.pinsLastRowXCoords.length < 2) return 0.8;
    const last = this.pinsLastRowXCoords;
    return (last[last.length - 1] - last[0]) / WIDTH;
  }

  private get pinDistanceX(): number {
    const lastRowPinCount = 3 + this.rowCount - 1;
    return (WIDTH - PADDING_X * 2) / (lastRowPinCount - 1);
  }

  private get pinRadius(): number {
    return (24 - this.rowCount) / 2;
  }

  private handleBallEnterBin(ball: Matter.Body) {
    const coords = this.pinsLastRowXCoords;
    const numBins = coords.length - 1;
    let binIndex = (coords as any).findLastIndex((pinX: number) => pinX < ball.position.x);

    if (binIndex === -1) binIndex = 0;
    else if (binIndex >= numBins) binIndex = numBins - 1;

    this.onBallLand({ ballId: ball.id, binIndex });
    Matter.Composite.remove(this.engine.world, ball);
  }

  private placePinsAndWalls() {
    if (this.pins.length > 0) {
      Matter.Composite.remove(this.engine.world, this.pins);
      this.pins = [];
    }
    this.pinsLastRowXCoords = [];
    if (this.walls.length > 0) {
      Matter.Composite.remove(this.engine.world, this.walls);
      this.walls = [];
    }

    for (let row = 0; row < this.rowCount; ++row) {
      const rowY =
        PADDING_TOP +
        ((HEIGHT - PADDING_TOP - PADDING_BOTTOM) / (this.rowCount - 1)) * row;
      const rowPaddingX =
        PADDING_X + ((this.rowCount - 1 - row) * this.pinDistanceX) / 2;

      for (let col = 0; col < 3 + row; ++col) {
        const colX =
          rowPaddingX + ((WIDTH - rowPaddingX * 2) / (3 + row - 1)) * col;
        const pin = Matter.Bodies.circle(colX, rowY, this.pinRadius, {
          isStatic: true,
          render: { fillStyle: "#ffffff" },
          collisionFilter: { category: PIN_CATEGORY, mask: BALL_CATEGORY },
        });
        this.pins.push(pin);
        if (row === this.rowCount - 1) {
          this.pinsLastRowXCoords.push(colX);
        }
      }
    }
    Matter.Composite.add(this.engine.world, this.pins);

    const firstPinX = this.pins[0].position.x;
    const leftWallAngle = Math.atan2(
      firstPinX - this.pinsLastRowXCoords[0],
      HEIGHT - PADDING_TOP - PADDING_BOTTOM,
    );
    const leftWallX =
      firstPinX -
      (firstPinX - this.pinsLastRowXCoords[0]) / 2 -
      this.pinDistanceX * 0.25;

    const leftWall = Matter.Bodies.rectangle(
      leftWallX,
      HEIGHT / 2,
      10,
      HEIGHT,
      {
        isStatic: true,
        angle: leftWallAngle,
        render: { visible: false },
      },
    );
    const rightWall = Matter.Bodies.rectangle(
      WIDTH - leftWallX,
      HEIGHT / 2,
      10,
      HEIGHT,
      {
        isStatic: true,
        angle: -leftWallAngle,
        render: { visible: false },
      },
    );
    this.walls.push(leftWall, rightWall);
    Matter.Composite.add(this.engine.world, this.walls);
  }

  private removeAllBalls() {
    const bodies = Matter.Composite.allBodies(this.engine.world);
    for (const body of bodies) {
      if (body.collisionFilter.category === BALL_CATEGORY) {
        Matter.Composite.remove(this.engine.world, body);
      }
    }
  }
}
