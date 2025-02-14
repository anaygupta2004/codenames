import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getSpymasterClue, getGuesserMove, discussAndVote, makeConsensusVote } from "./lib/ai-service";
import { insertGameSchema } from "@shared/schema";
import type { Game, GameState, TeamDiscussionEntry, ConsensusVote, GameHistoryEntry } from "@shared/schema";
import type { AIModel } from "./lib/ai-service";

function getRandomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Set JSON content type for all API responses
  app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
  });

  app.post("/api/games", async (req, res) => {
    try {
      const gameData = insertGameSchema.parse(req.body);
      const game = await storage.createGame(gameData);
      res.json(game);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/games/:id", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });
      res.json(game);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/clue", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const isRedTurn = game.currentTurn === "red_turn";
      const currentTeamWords = isRedTurn ? game.redTeam : game.blueTeam;
      const opposingTeamWords = isRedTurn ? game.blueTeam : game.redTeam;

      // Map the spymaster to a specific AI model
      const spymasterModel: AIModel = isRedTurn ? 
        (typeof game.redSpymaster === 'string' ? game.redSpymaster as AIModel : "gpt-4o") :
        (typeof game.blueSpymaster === 'string' ? game.blueSpymaster as AIModel : "gpt-4o");

      const clue = await getSpymasterClue(
        spymasterModel,
        game.words,
        currentTeamWords,
        opposingTeamWords,
        game.assassin,
        (game.gameHistory || []) as GameHistoryEntry[]
      );

      res.json(clue);
    } catch (error: any) {
      console.error("Error in AI clue:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/guess", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { clue } = req.body;
      if (!clue || !clue.word || typeof clue.number !== 'number') {
        return res.status(400).json({ error: "Invalid clue format" });
      }

      // Map the current player to a specific AI model
      const currentPlayer = game.currentTurn === "red_turn" ? game.redPlayers[0] : game.bluePlayers[0];
      const playerModel: AIModel = typeof currentPlayer === 'string' ? currentPlayer as AIModel : "gpt-4o";

      const guess = await getGuesserMove(
        playerModel,
        game.words,
        clue,
        game.revealedCards,
        (game.gameHistory || []) as GameHistoryEntry[]
      );

      res.json({ guess });
    } catch (error: any) {
      console.error("Error in AI guess:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/games/:id", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const updates: Partial<Game> = {};

      if (req.body.revealedCards) {
        const newCard = req.body.revealedCards[req.body.revealedCards.length - 1];

        if (game.redTeam.includes(newCard)) {
          updates.redScore = game.redScore + 1;
        } else if (game.blueTeam.includes(newCard)) {
          updates.blueScore = game.blueScore + 1;
        }

        if (newCard === game.assassin) {
          updates.gameState = game.currentTurn === "red_turn" ? "blue_win" : "red_win";
        }

        updates.revealedCards = req.body.revealedCards;
      }

      if (req.body.revealedCards && !updates.gameState) {
        updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
      }

      if (game.redTeam.every(word => req.body.revealedCards.includes(word))) {
        updates.gameState = "red_win";
      } else if (game.blueTeam.every(word => req.body.revealedCards.includes(word))) {
        updates.gameState = "blue_win";
      }

      const updatedGame = await storage.updateGame(game.id, updates);
      res.json(updatedGame);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/discuss", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, clue } = req.body;

      // Validate required parameters
      if (!model || !team) {
        return res.status(400).json({ error: "Missing required parameters: model and team" });
      }

      if (!clue || typeof clue.word !== 'string' || typeof clue.number !== 'number') {
        return res.status(400).json({ error: "Invalid clue format. Expected { word: string, number: number }" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      if (!currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      // Add random delay to simulate natural conversation flow
      await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 2000)));

      const teamDiscussion = game.teamDiscussion || [];
      const gameHistory = game.gameHistory || [];

      const discussion = await discussAndVote(
        model as AIModel,
        team,
        game.words,
        clue,
        teamDiscussion as TeamDiscussionEntry[],
        gameHistory as GameHistoryEntry[],
        game.revealedCards
      );

      const newDiscussionEntry: TeamDiscussionEntry = {
        team,
        player: model,
        message: discussion.message,
        confidence: discussion.confidence,
        timestamp: Date.now()
      };

      const updatedTeamDiscussion = [...teamDiscussion, newDiscussionEntry];

      await storage.updateGame(game.id, {
        teamDiscussion: updatedTeamDiscussion
      });

      res.json(newDiscussionEntry);
    } catch (error: any) {
      console.error("Error in AI discussion:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/vote", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, word } = req.body;
      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;

      if (!currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      const teamDiscussion = (game.teamDiscussion || []) as TeamDiscussionEntry[];
      const consensusVotes = (game.consensusVotes || []) as ConsensusVote[];

      const vote = await makeConsensusVote(
        model,
        team,
        word,
        teamDiscussion
      );

      const newVote: ConsensusVote = {
        team,
        player: model,
        word,
        approved: vote.approved,
        timestamp: Date.now()
      };

      const updatedGame = await storage.updateGame(game.id, {
        consensusVotes: [...consensusVotes, newVote]
      });

      const teamVotes = (updatedGame.consensusVotes as ConsensusVote[])
        .filter(v => v.team === team && v.word === word);
      const teamAIPlayers = currentTeamPlayers.filter(p => p !== "human");
      const allApproved = teamVotes.length === teamAIPlayers.length &&
        teamVotes.every(v => v.approved);

      res.json({ vote: newVote, allApproved });
    } catch (error: any) {
      console.error("Error in AI vote:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}