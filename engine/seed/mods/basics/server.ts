import type { Entity, ServerMod, World } from "../../api";

const color = (name: string) => `hsl(${[...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 360}, 70%, 60%)`;
const HEIGHT = 1.6;

function rules(world: World): Entity {
  return world.query("rules")[0]?.[1] ?? world.entities.get(world.spawn({ rules: true, gravity: 25, speed: 7, jump: 9 }))!;
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
    const { gravity, speed, jump } = rules(world);
    for (const [, e] of world.query("player", "pos", "vel", "input")) {
      const grounded = e.pos[1] <= HEIGHT / 2 + 0.001;
      e.vel[0] = e.input.x * speed;
      e.vel[2] = e.input.z * speed;
      e.vel[1] = grounded && e.input.jump ? jump : e.vel[1] - gravity * dt;
      for (let i = 0; i < 3; i++) e.pos[i] = Math.round((e.pos[i] + e.vel[i] * dt) * 1000) / 1000;
      if (e.pos[1] < HEIGHT / 2) {
        e.pos[1] = HEIGHT / 2;
        e.vel[1] = 0;
      }
    }
  },
} satisfies ServerMod;
