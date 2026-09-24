import type { Entity, ServerMod, World } from "../../api";

const color = (name: string) => `hsl(${[...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 360}, 70%, 60%)`;
const HEIGHT = 1.6;
const grounded = new Set<number>();

function rules(world: World): Entity {
  return world.query("rules")[0]?.[1] ?? world.entities.get(world.spawn({ rules: true, gravity: 25, speed: 7, jump: 9, step: 0.45 }))!;
}

function spawnAvatar(world: World, id: string, name: string) {
  world.spawn({
    player: id,
    label: name,
    pos: [Math.random() * 8 - 4, HEIGHT / 2, Math.random() * 8 - 4],
    vel: [0, 0, 0],
    input: { x: 0, z: 0, jump: false },
    mesh: { shape: "box", size: [0.9, HEIGHT, 0.9], color: color(name) },
  });
}

export default {
  load(world) {
    rules(world);
    if (!world.query("ground").length) world.spawn({ ground: true, pos: [0, -0.5, 0], mesh: { shape: "box", size: [400, 1, 400], color: "#7fa65a" } });
    for (const [, e] of world.query("ground")) e.solid ??= true;
    const avatars = world.query("player");
    for (const [id, e] of avatars) if (!world.players.has(e.player)) world.remove(id);
    for (const p of world.players.values()) if (!avatars.some(([, e]) => e.player === p.id)) spawnAvatar(world, p.id, p.name);
  },

  join(world, player) {
    spawnAvatar(world, player.id, player.name);
  },

  leave(world, player) {
    for (const [id, e] of world.query("player")) if (e.player === player.id) world.remove(id);
  },

  message(world, player, msg) {
    for (const [, e] of world.query("player")) if (e.player === player.id) e.input = { x: +msg.x || 0, z: +msg.z || 0, jump: !!msg.jump };
  },

  tick(world, dt) {
    const { gravity, speed, jump, step = 0.45 } = rules(world);
    for (const [id, e] of world.query("player", "pos", "vel", "input")) {
      e.vel[0] = e.input.x * speed;
      e.vel[2] = e.input.z * speed;
      e.vel[1] = grounded.has(id) && e.input.jump ? jump : e.vel[1] - gravity * dt;
      // pos is the middle of the avatar box; physics moves its feet.
      const moved = world.physics.move([e.pos[0], e.pos[1] - HEIGHT / 2, e.pos[2]], e.vel, dt, { radius: 0.45, height: HEIGHT, step });
      e.pos = [moved.pos[0]!, moved.pos[1]! + HEIGHT / 2, moved.pos[2]!].map((v) => Math.round(v * 1000) / 1000);
      e.vel = moved.vel;
      if (moved.grounded) grounded.add(id);
      else grounded.delete(id);
      if (e.pos[1] < -50) [e.pos, e.vel] = [[0, 5, 0], [0, 0, 0]];
    }
  },
} satisfies ServerMod;
