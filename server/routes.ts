import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getSpymasterClue, getGuesserMove, discussAndVote, makeConsensusVote } from "./lib/ai-service";
import { insertGameSchema } from "@shared/schema";
import type { Game, GameState, TeamDiscussionEntry, ConsensusVote, GameHistoryEntry } from "@shared/schema";

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

  app.post("/api/games/:id/ai/discuss", async (req, res) => {
    const game = await storage.getGame(Number(req.params.id));
    if (!game) return res.status(404).json({ message: "Game not found" });

    const { model, team } = req.body;
    const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;

    if (!currentTeamPlayers.includes(model)) {
      return res.status(400).json({ message: "AI model is not part of the team" });
    }

    const discussion = await discussAndVote(
      model,
      team,
      game.words,
      req.body.clue,
      game.teamDiscussion as TeamDiscussionEntry[],
      game.gameHistory as GameHistoryEntry[],
      game.revealedCards
    );

    const newDiscussionEntry: TeamDiscussionEntry = {
      team,
      player: model,
      message: discussion.message,
      confidence: discussion.confidence,
      timestamp: Date.now()
    };

    const updatedGame = await storage.updateGame(game.id, {
      teamDiscussion: [...(game.teamDiscussion as TeamDiscussionEntry[]), newDiscussionEntry]
    });

    res.json(newDiscussionEntry);
  });

  app.post("/api/games/:id/ai/vote", async (req, res) => {
    const game = await storage.getGame(Number(req.params.id));
    if (!game) return res.status(404).json({ message: "Game not found" });

    const { model, team, word } = req.body;
    const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;

    if (!currentTeamPlayers.includes(model)) {
      return res.status(400).json({ message: "AI model is not part of the team" });
    }

    const vote = await makeConsensusVote(
      model,
      team,
      word,
      game.teamDiscussion as TeamDiscussionEntry[]
    );

    const newVote: ConsensusVote = {
      team,
      player: model,
      word,
      approved: vote.approved,
      timestamp: Date.now()
    };

    const updatedGame = await storage.updateGame(game.id, {
      consensusVotes: [...(game.consensusVotes as ConsensusVote[]), newVote]
    });

    // Check if all AI team members have voted and approved
    const teamVotes = (updatedGame.consensusVotes as ConsensusVote[]).filter(v =>
      v.team === team && v.word === word
    );
    const teamAIPlayers = currentTeamPlayers.filter(p => p !== "human");
    const allApproved = teamVotes.length === teamAIPlayers.length &&
      teamVotes.every(v => v.approved);

    res.json({ vote: newVote, allApproved });
  });

  const httpServer = createServer(app);
  return httpServer;
}