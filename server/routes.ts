import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getSpymasterClue, getGuesserMove, discussAndVote, makeConsensusVote } from "./lib/ai-service";
import { insertGameSchema } from "@shared/schema";
import type { Game, GameState, TeamDiscussionEntry, ConsensusVote, GameHistoryEntry } from "@shared/schema";
import type { AIModel } from "./lib/ai-service";

const VALID_MODELS = ["gpt-4o", "claude-3-5-sonnet-20241022", "grok-2-1212", "gemini-pro"] as const;

function getRandomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Add type for clue tracking in game history
interface ClueHistoryEntry extends GameHistoryEntry {
  type: "clue";
  content: string;
}

interface GuessHistoryEntry extends GameHistoryEntry {
  type: "guess";
  word: string;
  relatedClue: string;
  result: "correct" | "wrong" | "assassin";
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
      const currentSpymaster = isRedTurn ? game.redSpymaster : game.blueSpymaster;

      if (!currentSpymaster || !VALID_MODELS.includes(currentSpymaster as AIModel)) {
        return res.status(400).json({ error: "Invalid spymaster configuration" });
      }

      const clue = await getSpymasterClue(
        currentSpymaster as AIModel,
        game.words,
        currentTeamWords,
        opposingTeamWords,
        game.assassin,
        game.gameHistory as GameHistoryEntry[] || []
      );

      // Add clue to game history
      const historyEntry: ClueHistoryEntry = {
        type: "clue",
        turn: isRedTurn ? "red" : "blue",
        content: `${clue.word} (${clue.number})`,
        timestamp: Date.now()
      };

      await storage.updateGame(game.id, {
        gameHistory: [...(game.gameHistory || []), historyEntry]
      });

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

      // Get current operative (not spymaster)
      const currentTeamPlayers = game.currentTurn === "red_turn" ? game.redPlayers : game.bluePlayers;
      const currentSpymaster = game.currentTurn === "red_turn" ? game.redSpymaster : game.blueSpymaster;
      const operatives = currentTeamPlayers.filter(player => player !== currentSpymaster);
      const currentOperative = operatives[0];

      if (!currentOperative || typeof currentOperative !== 'string' || currentOperative === 'human') {
        return res.status(400).json({ error: "No valid AI operative found" });
      }

      const guess = await getGuesserMove(
        currentOperative as AIModel,
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
        const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";

        // Get the last clue from history
        const lastClue = [...(game.gameHistory || [])]
          .reverse()
          .find(entry => entry.type === "clue");

        // Update scores
        if (game.redTeam.includes(newCard)) {
          updates.redScore = (game.redScore || 0) + 1;
        } else if (game.blueTeam.includes(newCard)) {
          updates.blueScore = (game.blueScore || 0) + 1;
        }

        // Determine guess result
        let result: "correct" | "wrong" | "assassin";
        if (newCard === game.assassin) {
          result = "assassin";
          updates.gameState = game.currentTurn === "red_turn" ? "blue_win" : "red_win";
        } else if (
          (game.currentTurn === "red_turn" && game.redTeam.includes(newCard)) ||
          (game.currentTurn === "blue_turn" && game.blueTeam.includes(newCard))
        ) {
          result = "correct";
        } else {
          result = "wrong";
        }

        updates.revealedCards = req.body.revealedCards;

        // Add to game history
        const historyEntry: GuessHistoryEntry = {
          type: "guess",
          turn: currentTeam,
          word: newCard,
          relatedClue: lastClue?.content || "",
          result,
          timestamp: Date.now()
        };

        updates.gameHistory = [...(game.gameHistory || []), historyEntry];

        // Update turn if guess was incorrect
        if (result === "wrong" || result === "assassin") {
          updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
        }

        // Check for victory conditions
        if (game.redTeam.every(word => req.body.revealedCards?.includes(word))) {
          updates.gameState = "red_win";
        } else if (game.blueTeam.every(word => req.body.revealedCards?.includes(word))) {
          updates.gameState = "blue_win";
        }
      }

      const updatedGame = await storage.updateGame(game.id, updates);
      res.json(updatedGame);
    } catch (error: any) {
      console.error("Error in patch game:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/discuss", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, clue } = req.body;

      if (!model || !team) {
        return res.status(400).json({ error: "Missing required parameters: model and team" });
      }

      if (!clue || typeof clue.word !== 'string' || typeof clue.number !== 'number') {
        return res.status(400).json({ error: "Invalid clue format" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      if (!currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      // Add a small random delay to make discussions feel more natural
      await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 2000)));

      const teamDiscussion = (game.teamDiscussion || []) as TeamDiscussionEntry[];
      const gameHistory = (game.gameHistory || []) as GameHistoryEntry[];

      const discussion = await discussAndVote(
        model as AIModel,
        team,
        game.words,
        clue,
        teamDiscussion,
        gameHistory,
        game.revealedCards
      );

      const newDiscussionEntry: TeamDiscussionEntry = {
        team,
        player: model as AIModel,
        message: discussion.message,
        confidence: discussion.confidence,
        timestamp: Date.now()
      };

      if (discussion.suggestedWord) {
        (newDiscussionEntry as any).suggestedWord = discussion.suggestedWord;
      }

      await storage.updateGame(game.id, {
        teamDiscussion: [...teamDiscussion, newDiscussionEntry]
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
        model as AIModel,
        team,
        word,
        teamDiscussion
      );

      const newVote: ConsensusVote = {
        team,
        player: model as AIModel,
        word,
        approved: vote.approved,
        timestamp: Date.now()
      };

      const updatedGame = await storage.updateGame(game.id, {
        consensusVotes: [...consensusVotes, newVote]
      });

      const teamVotes = (updatedGame.consensusVotes as ConsensusVote[])
        .filter(v => v.team === team && v.word === word);
      const teamAIPlayers = currentTeamPlayers.filter(p => p !== "human") as AIModel[];
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