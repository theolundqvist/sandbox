import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Game, GameStatus } from "./api";

export const GAME_ID = /^[a-z][a-z0-9-]{0,31}$/;
const STATUSES: GameStatus[] = ["live", "early", "building"];
/** Hex, a named colour or a colour function: anything a card can safely drop into CSS. */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl|oklch|oklab|lab|lch)a?\([\d\s.,%/+-]+\))$/i;
const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The card fields a Claude sets with create_game and edit_game. */
export type GameCard = Omit<Game, "createdBy" | "createdAt">;

/** Why these card fields can't be saved, or null; `partial` checks only the fields given, as edit_game does. */
export function cardError(card: Partial<GameCard>, partial: boolean): string | null {
  const given = (key: keyof GameCard) => !partial || card[key] !== undefined;
  if (given("id") && !GAME_ID.test(String(card.id ?? ""))) return `id must be lowercase letters, digits and dashes, starting with a letter, at most 32: ${GAME_ID}`;
  if (given("title") && !(typeof card.title === "string" && card.title.trim() && card.title.length <= 40)) return "title is 1 to 40 characters.";
  if (given("tagline") && !(typeof card.tagline === "string" && card.tagline.length <= 160)) return "tagline is at most 160 characters.";
  if (given("color") && !CSS_COLOR.test(String(card.color ?? ""))) return "color is a CSS colour like #1d6b4f.";
  if (card.accent !== undefined && !CSS_COLOR.test(String(card.accent))) return "accent is a CSS colour like #f3c969.";
  if (card.status !== undefined && !STATUSES.includes(card.status)) return `status is one of ${STATUSES.join(", ")}.`;
  if (card.order !== undefined && !Number.isFinite(card.order)) return "order is a number.";
  if (card.spawn !== undefined && !(Array.isArray(card.spawn) && card.spawn.length === 3 && card.spawn.every(Number.isFinite))) return "spawn is a position [x, y, z].";
  if (card.art !== undefined && !MOD_NAME.test(String(card.art))) return "art is the name of a client mod with paintCard.";
  return null;
}

const byPickerOrder = (a: Game, b: Game) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title);

/** The world's games, saved in games.json. */
export class GameRegistry {
  private games: Record<string, Game>;

  constructor(private path: string) {
    this.games = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  list() {
    return Object.values(this.games).sort(byPickerOrder);
  }

  get(id: string): Game | undefined {
    return Object.hasOwn(this.games, id) ? this.games[id] : undefined;
  }

  create(card: GameCard, createdBy: string) {
    const game: Game = { ...card, status: card.status ?? "building", createdBy, createdAt: Date.now() };
    this.games[game.id] = game;
    this.save();
    return game;
  }

  edit(id: string, fields: Partial<GameCard>) {
    const game = { ...this.games[id]!, ...fields, id };
    this.games[id] = game;
    this.save();
    return game;
  }

  remove(id: string) {
    delete this.games[id];
    this.save();
  }

  private save() {
    writeFileSync(this.path, JSON.stringify(this.games, null, 2));
  }
}

export type Vec3 = [number, number, number];
/** A player's current game, and where they last were in each game they left. */
export type SeatRecord = { game: string | null; lastPos: Record<string, Vec3> };

/** Where every player is, saved in seats.json so a player who comes back returns to their game and their place in it. */
export class Seats {
  private seats: Record<string, SeatRecord>;

  constructor(private path: string) {
    this.seats = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  get(player: string): SeatRecord {
    return Object.hasOwn(this.seats, player) ? this.seats[player]! : { game: null, lastPos: {} };
  }

  players() {
    return Object.keys(this.seats);
  }

  update(player: string, change: (seat: SeatRecord) => void) {
    const seat = this.get(player);
    change(seat);
    this.seats[player] = seat;
    this.save();
  }

  /** A deleted game leaves nobody in it and no place to return to. */
  forget(game: string) {
    for (const seat of Object.values(this.seats)) {
      if (seat.game === game) seat.game = null;
      delete seat.lastPos[game];
    }
    this.save();
  }

  private save() {
    writeFileSync(this.path, JSON.stringify(this.seats, null, 2));
  }
}
