import { pgTable, text, serial, integer, boolean } from "drizzle-orm/pg-core";
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
  // AI player assignments
  redSpymaster: boolean("red_spymaster_is_ai").notNull(),
  blueSpymaster: boolean("blue_spymaster_is_ai").notNull(),
  redPlayers: text("red_players").array().notNull(), // ["human", "gpt-4o", "claude-3-5-sonnet-20241022"]
  bluePlayers: text("blue_players").array().notNull(), // ["human", "gpt-4o", "grok-2-1212"]
  revealedCards: text("revealed_cards").array().notNull().default([]),
  // Game history for AI context
  gameHistory: text("game_history").array().notNull().default([]), // [{turn: "red", type: "clue", content: "nature 3"}, {turn: "red", type: "guess", content: "TREE", result: "correct"}]
});

export const insertGameSchema = createInsertSchema(games).omit({
  id: true,
  redScore: true,
  blueScore: true,
  revealedCards: true,
  gameHistory: true,
});

export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof games.$inferSelect;

export type CardType = "red" | "blue" | "neutral" | "assassin";
export type GameState = "red_turn" | "blue_turn" | "red_win" | "blue_win";
export type AIModel = "gpt-4o" | "claude-3-5-sonnet-20241022" | "grok-2-1212";
export type PlayerType = "human" | AIModel;

export type GameHistoryEntry = {
  turn: "red" | "blue";
  type: "clue" | "guess";
  content: string;
  result?: "correct" | "wrong" | "assassin";
};