import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getSpymasterClue, getGuesserMove } from "./lib/openai";
import { insertGameSchema } from "@shared/schema";
import type { Game, GameState } from "@shared/schema";

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/games", async (req, res) => {
    const gameData = insertGameSchema.parse(req.body);
    const game = await storage.createGame(gameData);
    res.json(game);
  });

  app.get("/api/games/:id", async (req, res) => {
    const game = await storage.getGame(Number(req.params.id));
    if (!game) return res.status(404).json({ message: "Game not found" });
    res.json(game);
  });

  app.patch("/api/games/:id", async (req, res) => {
    const game = await storage.getGame(Number(req.params.id));
    if (!game) return res.status(404).json({ message: "Game not found" });

    const updates: Partial<Game> = {};

    // Handle revealed cards
    if (req.body.revealedCards) {
      const newCard = req.body.revealedCards[req.body.revealedCards.length - 1];

      // Update score based on the revealed card
      if (game.redTeam.includes(newCard)) {
        updates.redScore = game.redScore + 1;
      } else if (game.blueTeam.includes(newCard)) {
        updates.blueScore = game.blueScore + 1;
      }

      // Check for assassin
      if (newCard === game.assassin) {
        updates.gameState = game.currentTurn === "red_turn" ? "blue_win" : "red_win";
      }

      updates.revealedCards = req.body.revealedCards;
    }

    // Switch turns if a card was revealed
    if (req.body.revealedCards && !updates.gameState) {
      updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
    }

    // Check for victory conditions
    if (game.redTeam.every(word => req.body.revealedCards.includes(word))) {
      updates.gameState = "red_win";
    } else if (game.blueTeam.every(word => req.body.revealedCards.includes(word))) {
      updates.gameState = "blue_win";
    }

    const updatedGame = await storage.updateGame(game.id, updates);
    res.json(updatedGame);
  });

  app.post("/api/games/:id/ai/clue", async (req, res) => {
    const game = await storage.getGame(Number(req.params.id));
    if (!game) return res.status(404).json({ message: "Game not found" });

    const clue = await getSpymasterClue(
      game.words,
      game.currentTurn === "red_turn" ? game.redTeam : game.blueTeam,
      game.currentTurn === "red_turn" ? game.blueTeam : game.redTeam,
      game.assassin
    );

    res.json(clue);
  });

  app.post("/api/games/:id/ai/guess", async (req, res) => {
    const game = await storage.getGame(Number(req.params.id));
    if (!game) return res.status(404).json({ message: "Game not found" });

    const guess = await getGuesserMove(
      game.words,
      req.body.clue,
      game.revealedCards
    );

    res.json({ guess });
  });

  const httpServer = createServer(app);
  return httpServer;
}