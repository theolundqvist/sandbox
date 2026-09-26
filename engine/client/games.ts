import type { Game } from "../api";

export type { Game };
/** Where a player is: in one of the world's games, or in the world itself (null). */
export type Seat = { player: string; name: string; game: string | null; online: boolean };
type Painter = (canvas: HTMLCanvasElement, t: number) => void;

/** Stand-in for the game picker: a plain list of games with a play button each. The picker branch replaces this file with the real one. */
export function mountPicker(root: ShadowRoot | HTMLElement, opts: { me: string; onPlay(gameId: string | null): void; onClose?(): void; paintArt(gameId: string): Painter | null }) {
  const el = document.createElement("div");
  el.hidden = true;
  el.style.cssText = "position:fixed;inset:0;z-index:10;background:rgba(6,7,9,.92);color:#fff;padding:48px;overflow:auto;font:16px system-ui";
  root.append(el);
  let games: Game[] = [];
  let seats: Seat[] = [];
  let mods: Record<string, number> = {};
  let covered = false;

  function build() {
    const here = seats.find((s) => s.player === opts.me)?.game ?? null;
    el.replaceChildren(
      ...games.map((g) => {
        const button = document.createElement("button");
        const soon = g.status === "building" && !mods[g.id];
        button.textContent = `${g.title} · ${g.id === here ? "RESUME" : soon ? "COMING SOON" : "PLAY"}`;
        button.disabled = soon || covered;
        button.onclick = () => (g.id === here ? close() : opts.onPlay(g.id));
        return button;
      }),
      ...(here ? [Object.assign(document.createElement("button"), { textContent: "Back to the world", onclick: () => opts.onPlay(null) })] : []),
    );
  }
  function open() {
    el.hidden = false;
    build();
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    opts.onClose?.();
  }
  el.addEventListener("keydown", (e) => e.key === "Escape" && close());

  return {
    update(nextGames: Game[], nextSeats: Seat[], nextMods: Record<string, number>) {
      [games, seats, mods] = [nextGames, nextSeats, nextMods ?? {}];
      if (!el.hidden) build();
    },
    open,
    close,
    isOpen: () => !el.hidden,
    switching(gameId: string | null) {
      covered = gameId !== null;
      if (!el.hidden) build();
    },
  };
}
