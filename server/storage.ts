import { type Game, type InsertGame, type TeamDiscussionEntry, type ConsensusVote, type GameHistoryEntry } from "@shared/schema";

export interface IStorage {
  createGame(game: InsertGame): Promise<Game>;
  getGame(id: number): Promise<Game | undefined>;
  updateGame(id: number, updates: Partial<Game>): Promise<Game>;
  deleteGame(id: number): Promise<boolean>;
}

export class MemStorage implements IStorage {
  private games: Map<number, Game>;

  constructor() {
    this.games = new Map();
  }

  private generateGameId(): number {
    // Generate a 6-digit number between 100000 and 999999
    let gameId: number;
    do {
      gameId = Math.floor(Math.random() * 900000) + 100000;
    } while (this.games.has(gameId));
    return gameId;
  }

  async createGame(insertGame: InsertGame): Promise<Game> {
    const id = this.generateGameId();
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
        ? game.teamDiscussion.map((entry: unknown) => 
            typeof entry === 'string' ? JSON.parse(entry) as TeamDiscussionEntry : entry as TeamDiscussionEntry
          )
        : [],
      gameHistory: Array.isArray(game.gameHistory)
        ? game.gameHistory.map((entry: unknown) =>
            typeof entry === 'string' ? JSON.parse(entry) as GameHistoryEntry : entry as GameHistoryEntry
          )
        : [],
      consensusVotes: Array.isArray(game.consensusVotes)
        ? game.consensusVotes.map((entry: unknown) =>
            typeof entry === 'string' ? JSON.parse(entry) as ConsensusVote : entry as ConsensusVote
          )
        : []
    };
  }

  async updateGame(id: number, updates: Partial<Game>): Promise<Game> {
    console.log('Updating game storage, current updates:', updates);
    const game = await this.getGame(id);
    if (!game) {
      throw new Error('Game not found');
    }

    if (updates.teamDiscussion) {
      console.log('Updating team discussion:', {
        current: game.teamDiscussion?.length,
        new: updates.teamDiscussion.length,
        combined: [...(game.teamDiscussion || []), ...updates.teamDiscussion].length
      });
    }

    const updatedGame = {
      ...game,
      ...updates,
      teamDiscussion: updates.teamDiscussion || game.teamDiscussion,
      gameHistory: updates.gameHistory || game.gameHistory,
      consensusVotes: updates.consensusVotes || game.consensusVotes
    };

    console.log('Final updated game discussion count:', updatedGame.teamDiscussion?.length);
    this.games.set(id, updatedGame);
    return updatedGame;
  }

  async deleteGame(id: number): Promise<boolean> {
    if (!this.games.has(id)) {
      return false;
    }
    return this.games.delete(id);
  }
}

export const storage = new MemStorage();