import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  words: text("words").array().notNull(),
  redTeam: text("red_team").array().notNull(),
  blueTeam: text("blue_team").array().notNull(),
  neutralWords: text("neutral_words").array().notNull(),
  assassin: text("assassin").notNull(),
  currentTurn: text("current_turn").notNull(),
  redScore: integer("red_score").notNull().default(0),
  blueScore: integer("blue_score").notNull().default(0),
  gameState: text("game_state").notNull(),
  // AI player assignments - store actual model names instead of booleans
  redSpymaster: text("red_spymaster").notNull(),
  blueSpymaster: text("blue_spymaster").notNull(),
  redPlayers: text("red_players").array().notNull(),
  bluePlayers: text("blue_players").array().notNull(),
  revealedCards: text("revealed_cards").array().notNull().default([]),
  // Game time limits
  startTime: timestamp("start_time").notNull(),
  gameDuration: integer("game_duration").notNull().default(1800), // 30 minutes in seconds
  turnTimeLimit: integer("turn_time_limit").notNull().default(180), // 3 minutes per turn
  currentTurnStartTime: timestamp("current_turn_start_time").notNull(),
  // Game history for AI context
  gameHistory: text("game_history").array().notNull().default([]),
  teamDiscussion: text("team_discussion").array().notNull().default([]),
  consensusVotes: text("consensus_votes").array().notNull().default([]),
});

export const insertGameSchema = createInsertSchema(games).omit({
  id: true,
  redScore: true,
  blueScore: true,
  revealedCards: true,
  gameHistory: true,
  teamDiscussion: true,
  consensusVotes: true,
  startTime: true,
  currentTurnStartTime: true,
});

export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof games.$inferSelect;

export type CardType = "red" | "blue" | "neutral" | "assassin";
export type GameState = "red_turn" | "blue_turn" | "red_win" | "blue_win" | "time_up";
export type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212" | "llama-7b" | "gemini-pro";
export type PlayerType = "human" | AIModel;

export type GameHistoryEntry = {
  turn: "red" | "blue";
  type: "clue" | "guess";
  content: string;
  result?: "correct" | "wrong" | "assassin";
  timestamp: number;
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