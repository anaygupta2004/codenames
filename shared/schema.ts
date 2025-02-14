import { pgTable, text, serial, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  words: text("words").array().notNull(),
  redTeam: text("red_team").array().notNull(),
  blueTeam: text("blue_team").array().notNull(),
  assassin: text("assassin").notNull(),
  currentTurn: text("current_turn").notNull(),
  redScore: integer("red_score").notNull().default(0),
  blueScore: integer("blue_score").notNull().default(0),
  gameState: text("game_state").notNull(),
  redSpymaster: boolean("red_spymaster_is_ai").notNull(),
  blueSpymaster: boolean("blue_spymaster_is_ai").notNull(),
  revealedCards: text("revealed_cards").array().notNull().default([]),
  aiModel: text("ai_model").notNull().default("gpt-4o"),
});

export const insertGameSchema = createInsertSchema(games).omit({
  id: true,
  redScore: true,
  blueScore: true,
  revealedCards: true,
});

export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof games.$inferSelect;

export type CardType = "red" | "blue" | "neutral" | "assassin";
export type GameState = "red_turn" | "blue_turn" | "red_win" | "blue_win";
