import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { getSpymasterClue, getGuesserMove, discussAndVote, makeConsensusVote } from "./lib/ai-service";
import { insertGameSchema } from "@shared/schema";
import type { Game, GameState, TeamDiscussionEntry, ConsensusVote, GameHistoryEntry } from "@shared/schema";
import type { AIModel } from "./lib/ai-service";

const VALID_MODELS = ["gpt-4o", "claude-3-5-sonnet-20241022", "grok-2-1212", "gemini-pro"] as const;

// Track active game discussions
const gameDiscussions = new Map<number, {
  clients: Set<WebSocket>;
  activeTeams: Set<string>;
}>();

function initializeGameRoom(gameId: number) {
  if (!gameDiscussions.has(gameId)) {
    gameDiscussions.set(gameId, {
      clients: new Set(),
      activeTeams: new Set()
    });
  }
  return gameDiscussions.get(gameId)!;
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Initialize WebSocket server
  const wss = new WebSocketServer({ 
    server: httpServer, 
    path: '/ws',
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('New WebSocket connection established');
    let gameId: number | null = null;
    let currentTeam: string | null = null;

    ws.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        console.log('Received WebSocket message:', data);

        if (data.type === 'join') {
          gameId = Number(data.gameId);
          currentTeam = data.team;
          const gameRoom = initializeGameRoom(gameId);
          gameRoom.clients.add(ws);
          if (currentTeam) {
            gameRoom.activeTeams.add(currentTeam);
          }
          console.log(`Team ${currentTeam} joined game ${gameId}`);
        }

        if (data.type === 'discussion' && gameId) {
          const gameRoom = gameDiscussions.get(gameId);
          if (gameRoom?.clients) {
            const messageData = JSON.stringify({
              type: 'discussion',
              content: data.content,
              team: data.team,
              player: data.player,
              confidence: data.confidence,
              suggestedWord: data.suggestedWord,
              timestamp: Date.now()
            });

            gameRoom.clients.forEach(client => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(messageData);
              }
            });
          }
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      if (gameId) {
        const gameRoom = gameDiscussions.get(gameId);
        if (gameRoom) {
          gameRoom.clients.delete(ws);
          if (currentTeam) {
            gameRoom.activeTeams.delete(currentTeam);
          }
          if (gameRoom.clients.size === 0) {
            gameDiscussions.delete(gameId);
          }
          console.log(`Team ${currentTeam} left game ${gameId}`);
        }
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
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
        game.gameHistory || []
      );

      const historyEntry: GameHistoryEntry = {
        type: "clue",
        turn: isRedTurn ? "red" : "blue",
        content: `${clue.word} (${clue.number})`,
        timestamp: Date.now()
      };

      await storage.updateGame(game.id, {
        gameHistory: game.gameHistory ? [...game.gameHistory, historyEntry] : [historyEntry]
      });

      res.json(clue);
    } catch (error: any) {
      console.error("Error in AI clue:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/discuss", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, clue } = req.body;
      if (!model || !team || !VALID_MODELS.includes(model as AIModel)) {
        return res.status(400).json({ error: "Invalid model or team" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      if (!currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      const discussion = await discussAndVote(
        model as AIModel,
        team,
        game.words,
        clue,
        game.teamDiscussion || [],
        game.gameHistory || [],
        game.revealedCards
      );

      const newDiscussionEntry: TeamDiscussionEntry = {
        team,
        player: model,
        message: discussion.message,
        confidence: discussion.confidence,
        suggestedWord: discussion.suggestedWord,
        timestamp: Date.now()
      };

      const updatedDiscussion = game.teamDiscussion 
        ? [...game.teamDiscussion, newDiscussionEntry]
        : [newDiscussionEntry];

      await storage.updateGame(game.id, {
        teamDiscussion: updatedDiscussion
      });

      res.json(newDiscussionEntry);
    } catch (error: any) {
      console.error("Error in AI discussion:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/guess", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { clue, model } = req.body;
      if (!clue || !clue.word || typeof clue.number !== 'number') {
        return res.status(400).json({ error: "Invalid clue format" });
      }

      if (!model || !VALID_MODELS.includes(model as AIModel)) {
        return res.status(400).json({ error: "Invalid AI model" });
      }

      const guess = await getGuesserMove(
        model as AIModel,
        game.words,
        clue,
        game.revealedCards,
        game.gameHistory || []
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

        const gameHistory = game.gameHistory || [];
        const lastClue = [...gameHistory]
          .reverse()
          .find(entry => entry.type === "clue");

        if (game.redTeam.includes(newCard)) {
          updates.redScore = (game.redScore || 0) + 1;
        } else if (game.blueTeam.includes(newCard)) {
          updates.blueScore = (game.blueScore || 0) + 1;
        }

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

        const historyEntry: GameHistoryEntry = {
          type: "guess",
          turn: currentTeam,
          content: `Guessed: ${newCard}`,
          timestamp: Date.now()
        };

        updates.gameHistory = game.gameHistory 
          ? [...game.gameHistory, historyEntry]
          : [historyEntry];

        if (result === "wrong" || result === "assassin") {
          updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
        }

        if (game.redTeam.every(word => req.body.revealedCards?.includes(word))) {
          updates.gameState = "red_win";
        } else if (game.blueTeam.every(word => req.body.revealedCards?.includes(word))) {
          updates.gameState = "blue_win";
        }
      }

      if (req.body.currentTurn) {
        updates.currentTurn = req.body.currentTurn;
        updates.teamDiscussion = [];
        updates.consensusVotes = [];
      }

      const updatedGame = await storage.updateGame(game.id, updates);
      res.json(updatedGame);
    } catch (error: any) {
      console.error("Error in patch game:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/vote", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, word } = req.body;

      if (!model || !team || !VALID_MODELS.includes(model as AIModel)) {
        return res.status(400).json({ error: "Invalid model or team" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      if (!currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      const vote = await makeConsensusVote(
        model as AIModel,
        team,
        word,
        game.teamDiscussion || []
      );

      const newVote: ConsensusVote = {
        team,
        player: model as AIModel,
        word,
        approved: vote.approved,
        timestamp: Date.now()
      };

      const updatedVotes = game.consensusVotes 
        ? [...game.consensusVotes, newVote]
        : [newVote];

      const updatedGame = await storage.updateGame(game.id, {
        consensusVotes: updatedVotes
      });

      const teamAIPlayers = currentTeamPlayers.filter(
        p => p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      ) as AIModel[];

      const teamVotes = updatedVotes.filter(v => v.team === team && v.word === word);
      const allVoted = teamVotes.length === teamAIPlayers.length;
      const allApproved = allVoted && teamVotes.every(v => v.approved);

      res.json({
        vote: newVote,
        allVoted,
        allApproved
      });
    } catch (error: any) {
      console.error("Error in AI vote:", error);
      res.status(500).json({ error: error.message });
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

  app.post("/api/games", async (req, res) => {
    try {
      const gameData = insertGameSchema.parse(req.body);
      const game = await storage.createGame(gameData);
      res.json(game);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
  });

  return httpServer;
}