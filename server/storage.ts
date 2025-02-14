import { games, type Game, type InsertGame, type TeamDiscussionEntry, type ConsensusVote, type GameHistoryEntry } from "@shared/schema";

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
    const now = new Date();
    const game: Game = {
      ...insertGame,
      id,
      redScore: 0,
      blueScore: 0,
      revealedCards: [],
      gameHistory: [],
      teamDiscussion: [],
      consensusVotes: [],
      startTime: now,
      currentTurnStartTime: now,
    };
    this.games.set(id, game);
    return game;
  }

  async getGame(id: number): Promise<Game | undefined> {
    const game = this.games.get(id);
    if (!game) return undefined;

    return {
      ...game,
      teamDiscussion: game.teamDiscussion.map(entry => 
        typeof entry === 'string' ? JSON.parse(entry) : entry
      ) as TeamDiscussionEntry[],
      gameHistory: game.gameHistory.map(entry =>
        typeof entry === 'string' ? JSON.parse(entry) : entry
      ) as GameHistoryEntry[],
      consensusVotes: game.consensusVotes.map(entry =>
        typeof entry === 'string' ? JSON.parse(entry) : entry
      ) as ConsensusVote[],
    };
  }

  async updateGame(id: number, updates: Partial<Game>): Promise<Game> {
    const game = await this.getGame(id);
    if (!game) throw new Error("Game not found");

    // Handle serialization of complex types
    const processedUpdates = {
      ...updates,
      teamDiscussion: updates.teamDiscussion?.map(entry =>
        typeof entry === 'string' ? entry : JSON.stringify(entry)
      ),
      gameHistory: updates.gameHistory?.map(entry =>
        typeof entry === 'string' ? entry : JSON.stringify(entry)
      ),
      consensusVotes: updates.consensusVotes?.map(entry =>
        typeof entry === 'string' ? entry : JSON.stringify(entry)
      ),
    };

    const updatedGame = { ...game, ...processedUpdates };
    this.games.set(id, updatedGame);
    return updatedGame;
  }
}

export const storage = new MemStorage();