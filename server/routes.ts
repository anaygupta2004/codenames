import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getSpymasterClue, getGuesserMove } from "./lib/openai";
import { insertGameSchema } from "@shared/schema";

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
