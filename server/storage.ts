import { games, type Game, type InsertGame, type TeamDiscussionEntry, type ConsensusVote } from "@shared/schema";

export interface IStorage {
  createGame(game: InsertGame): Promise<Game>;
  getGame(id: number): Promise<Game | undefined>;
  updateGame(id: number, updates: Partial<Game>): Promise<Game>;
}

export class MemStorage implements IStorage {
  private games: Map<number, Game>;
  private currentId: number;

  constructor() {
    this.games = new Map();
    this.currentId = 1;
  }

  async createGame(insertGame: InsertGame): Promise<Game> {
    const id = this.currentId++;
    const game: Game = {
      ...insertGame,
      id,
      redScore: 0,
      blueScore: 0,
      revealedCards: [],
      gameHistory: [],
      teamDiscussion: [],
      consensusVotes: []
    };
    this.games.set(id, game);
    return game;
  }

  async getGame(id: number): Promise<Game | undefined> {
    return this.games.get(id);
  }

  async updateGame(id: number, updates: Partial<Game>): Promise<Game> {
    const game = this.games.get(id);
    if (!game) throw new Error("Game not found");

    const updatedGame = { ...game, ...updates };
    this.games.set(id, updatedGame);
    return updatedGame;
  }
}

export const storage = new MemStorage();