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
  metaVotes?: MetaVote[]; // Added for continue/end turn votes
};

export type GameState = "red_turn" | "blue_turn" | "red_win" | "blue_win" | "time_up";
export type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212" | "llama-7b" | "gemini-1.5-pro";
export type PlayerType = "human" | AIModel;

export type GameHistoryEntry = {
  type: "clue" | "guess" | "end_turn" | "turn_end" | string;
  turn: "red" | "blue";
  content: string;
  timestamp: number;
  relatedClue?: string;
  word?: string; // Make word optional to accommodate different entry types
  result?: "correct" | "wrong" | "assassin" | "pending";
  reasoning?: string; // Added for better game log understanding
};

export type RiskLevel = "High" | "Medium" | "Low";

export type TeamDiscussionEntry = {
  team: "red" | "blue";
  player: AIModel | "human" | "Game";
  message: string;
  confidences: number[];
  timestamp: number;
  suggestedWords: string[];
  risk?: RiskLevel;
  round?: number;
  isVoting?: boolean;
  voteType?: "continue" | "end_turn" | "meta_decision" | "meta";
  voteResult?: boolean;
  action?: "vote" | "continue" | "end_turn";
  content?: string;
  pollId?: string;  // Add pollId for meta voting consistency
  timeInfo?: {
    turnStartTime: number;
    turnTimeLimit: number;
    remainingTime: number;
  };
};

export type ConsensusLevel = "High" | "Medium" | "Low" | "None";

export type ConsensusVote = {
  team: "red" | "blue";
  player: AIModel | "human" | string; // Supports model#uniqueId format
  word: string;
  approved: boolean;
  confidence: number;
  timestamp: number;
  reason?: string;
  relatedClue?: string; // Reference to the clue that this vote is for
  clueGuessCount?: number; // Number of guesses already made with related clue
  remainingScore?: number; // Score needed to win
  gameScore?: { red: number, blue: number }; // Current score
};

export type MetaVote = {
  team: "red" | "blue";
  player: AIModel | "human" | string; // Now supports model#uniqueId format
  action: "continue" | "end_turn";
  timestamp: number;
  confidence: number;
  pollId: string; // Required field for consistency
  messageId?: string; // Add messageId for reliable message-to-vote mapping
  reasoning?: string; // Add reasoning from the model's decision
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