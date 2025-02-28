import { z } from "zod";

export type Game = {
  id: number;
  words: string[];
  redTeam: string[];
  blueTeam: string[];
  neutralWords: string[];
  assassin: string;
  currentTurn: string;
  redScore: number;
  blueScore: number;
  gameState: GameState;
  redSpymaster: string;
  blueSpymaster: string;
  redPlayers: string[];
  bluePlayers: string[];
  revealedCards: string[];
  startTime: Date;
  gameDuration: number;
  turnTimeLimit: number;
  currentTurnStartTime: Date;
  gameHistory: GameHistoryEntry[];
  teamDiscussion: TeamDiscussionEntry[];
  consensusVotes: ConsensusVote[];
};

export type GameState = "red_turn" | "blue_turn" | "red_win" | "blue_win" | "time_up";
export type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212" | "llama-7b" | "gemini-1.5-pro";
export type PlayerType = "human" | AIModel;

export type GameHistoryEntry = {
  type: "clue" | "guess";
  turn: "red" | "blue";
  content: string;
  timestamp: number;
  relatedClue?: string;
  word?: string;
  result?: "correct" | "wrong" | "assassin";
};

export type TeamDiscussionEntry = {
  team: "red" | "blue";
  player: AIModel;
  message: string;
  confidence: number;
  timestamp: number;
  suggestedWord?: string;
};

export type ConsensusVote = {
  team: "red" | "blue";
  player: AIModel;
  word: string;
  approved: boolean;
  timestamp: number;
};

export const insertGameSchema = z.object({
  words: z.array(z.string()),
  redTeam: z.array(z.string()),
  blueTeam: z.array(z.string()),
  neutralWords: z.array(z.string()),
  assassin: z.string(),
  currentTurn: z.string(),
  gameState: z.enum(["red_turn", "blue_turn", "red_win", "blue_win", "time_up"]),
  redSpymaster: z.string(),
  blueSpymaster: z.string(),
  redPlayers: z.array(z.string()),
  bluePlayers: z.array(z.string()),
  gameDuration: z.number().optional(),
  turnTimeLimit: z.number().optional()
});

export type InsertGame = z.infer<typeof insertGameSchema>;