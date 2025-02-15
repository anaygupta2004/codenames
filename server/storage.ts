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
      gameDuration: insertGame.gameDuration || 1800,
      turnTimeLimit: insertGame.turnTimeLimit || 180
    };
    this.games.set(id, game);
    return game;
  }

  async getGame(id: number): Promise<Game | undefined> {
    const game = this.games.get(id);
    if (!game) return undefined;

    return {
      ...game,
      teamDiscussion: Array.isArray(game.teamDiscussion) 
        ? game.teamDiscussion.map(entry => 
            typeof entry === 'string' ? JSON.parse(entry) as TeamDiscussionEntry : entry
          )
        : [],
      gameHistory: Array.isArray(game.gameHistory)
        ? game.gameHistory.map(entry =>
            typeof entry === 'string' ? JSON.parse(entry) as GameHistoryEntry : entry
          )
        : [],
      consensusVotes: Array.isArray(game.consensusVotes)
        ? game.consensusVotes.map(entry =>
            typeof entry === 'string' ? JSON.parse(entry) as ConsensusVote : entry
          )
        : []
    };
  }

  async updateGame(id: number, updates: Partial<Game>): Promise<Game> {
    const game = await this.getGame(id);
    if (!game) throw new Error("Game not found");

    const updatedGame = {
      ...game,
      ...updates,
      teamDiscussion: updates.teamDiscussion || game.teamDiscussion,
      gameHistory: updates.gameHistory || game.gameHistory,
      consensusVotes: updates.consensusVotes || game.consensusVotes
    };

    this.games.set(id, updatedGame);
    return updatedGame;
  }
}

export const storage = new MemStorage();