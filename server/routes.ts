import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { 
  getSpymasterClue, 
  getGuesserMove, 
  discussAndVote, 
  makeConsensusVote,
  formatDiscussionMessage,
  updateTeamMemory 
} from "./lib/ai-service";
import { insertGameSchema } from "@shared/schema";
import type { Game, GameState, TeamDiscussionEntry, ConsensusVote, GameHistoryEntry } from "@shared/schema";
import type { AIModel } from "./lib/ai-service";

const VALID_MODELS = ["gpt-4o", "claude-3-5-sonnet-20241022", "grok-2-1212", "gemini-1.5-pro"] as const;

// Track active game discussions
let latestGameId: number | null = null;  // Track most recent game
const gameDiscussions = new Map<number, {
  clients: Set<WebSocket>;
  activeTeams: Set<string>;
  teamModels: {
    red: Set<AIModel>;
    blue: Set<AIModel>;
  };
  lastSpymasterClue: Map<string, { word: string; number: number }>;
  aiDiscussionInProgress: boolean;
}>();

const MAX_MODELS_PER_GAME = 6;  // Maximum total AI models per game
const MAX_MODELS_PER_TEAM = 3;  // Maximum AI models per team

// Track all active connections for cleanup
const activeConnections = new Set<WebSocket>();

const CONNECTION_LIMITS = {
  CONNECTIONS_PER_GAME: 10,
  CONNECTIONS_PER_TEAM: 5,
  RATE_LIMIT_WINDOW: 5000, // 5 seconds
};

const RATE_LIMIT = {
  MAX_CONNECTIONS_PER_CLIENT: 1,
  COOLDOWN_MS: 1000
};

// Track last connection time per client
const clientConnectionTimes = new Map<string, number>();

// Track connection attempts
const connectionAttempts = new Map<string, number>();

function cleanupGame(gameId: number) {
  const gameRoom = gameDiscussions.get(gameId);
  if (gameRoom) {
    // Don't close connections, just clear the game state
    gameRoom.teamModels.red.clear();
    gameRoom.teamModels.blue.clear();
    gameRoom.activeTeams.clear();
    gameRoom.lastSpymasterClue.clear();
    gameRoom.aiDiscussionInProgress = false;
    gameDiscussions.delete(gameId);
  }
}

function initializeGameRoom(gameId: number) {
  if (!gameDiscussions.has(gameId)) {
    gameDiscussions.set(gameId, {
      clients: new Set(),
      activeTeams: new Set(),
      teamModels: {
        red: new Set(),
        blue: new Set()
      },
      lastSpymasterClue: new Map(),
      aiDiscussionInProgress: false
    });
  }
  return gameDiscussions.get(gameId)!;
}

async function handleAIDiscussion(
  gameId: number, 
  team: string, 
  clue: { word: string; number: number },
  aiPlayers: AIModel[]
) {
  console.log(`Starting AI discussion for game ${gameId}, team ${team}, clue: ${clue.word}`);
  const gameRoom = gameDiscussions.get(gameId);
  console.log('Current game room state:', {
    hasRoom: !!gameRoom,
    inProgress: gameRoom?.aiDiscussionInProgress,
    teamModels: gameRoom?.teamModels
  });

  if (!gameRoom || gameRoom.aiDiscussionInProgress) {
    console.log('Discussion blocked - gameRoom missing or discussion in progress');
    return;
  }

  gameRoom.aiDiscussionInProgress = true;
  let guessCount = 0;
  const maxGuesses = clue.number + 1; // maximum allowed guesses (can be raised if desired)
  let continueGuessing = true; // flag to continue discussion
  
  try {
    while (continueGuessing) {
      const game = await storage.getGame(gameId);
      console.log('Current game discussion state:', {
        discussionCount: game?.teamDiscussion?.length,
        lastMessages: game?.teamDiscussion?.slice(-3)
      });

      // Retrieve the current game state
      if (!game) break;
  
      // Run discussions in parallel via each AI agent (spymaster messages as well as regular discussion)
      const discussionPromises = aiPlayers.map(async (aiPlayer) => {
        console.log(`Getting discussion from ${aiPlayer}`);
        const discussion = await discussAndVote(
          aiPlayer,
          team as "red" | "blue",
          game.words,
          clue,
          game.teamDiscussion || [],
          game.gameHistory || [],
          game.revealedCards || []
        );
        console.log(`${aiPlayer} discussion result:`, discussion);
        return { player: aiPlayer, discussion };
      });
      const discussions = await Promise.all(discussionPromises);
  
      // For each AI agent, broadcast its discussion message so the team discussion chat is updated
      const newDiscussionMessages = discussions.map(({ player, discussion }) => ({
        team: team as "red" | "blue",
        player,
        message: formatDiscussionMessage(
          player, 
          discussion.message, 
          discussion.confidence, 
          discussion.suggestedWord
        ),
        confidence: discussion.confidence,
        suggestedWord: discussion.suggestedWord,
        timestamp: Date.now()
      }));

      console.log('All AI discussions received:', discussions);
      console.log('Formatted discussion messages:', newDiscussionMessages);

      // Update game state with new discussion messages
      if (game) {
        console.log('Previous game discussion:', game.teamDiscussion);
        const updatedGame = await storage.updateGame(gameId, {
          teamDiscussion: [
            ...(game.teamDiscussion || []),
            ...newDiscussionMessages
          ]
        });
        console.log('Updated game discussion:', updatedGame.teamDiscussion);
      }

      newDiscussionMessages.forEach(msg => {
         gameRoom.clients.forEach(client => {
           if (client.readyState === WebSocket.OPEN) {
             console.log('Broadcasting discussion to client:', msg);
             client.send(JSON.stringify({
               type: 'discussion',
               ...msg,
               team: team as "red" | "blue"
             }));
           }
         });
      });
  
      // Process suggestions — allow agents to guess if they are confident
      const suggestions = discussions
        .filter(({ discussion }) => discussion.suggestedWord && discussion.confidence > 0.6)  // Lower confidence threshold
        .map(({ player, discussion }) => ({
            word: discussion.suggestedWord!,
            confidence: discussion.confidence,
            player
        }));
  
      // Group suggestions by word to gauge consensus
      const wordCounts = suggestions.reduce((acc, { word }) => {
         acc[word] = (acc[word] || 0) + 1;
         return acc;
      }, {} as Record<string, number>);

      // Lower consensus requirement - any suggestion with confidence > 0.8 or agreed by 2+ agents
      const bestSuggestions = suggestions
        .filter(s => s.confidence > 0.8 || wordCounts[s.word] >= 2)
        .sort((a, b) => b.confidence - a.confidence);
  
      // If no qualified suggestion remains, end discussion
      if (bestSuggestions.length === 0) {
         break;
      }
  
      // For each qualified suggestion, process a guess:
      for (const suggestion of bestSuggestions) {
         if (guessCount >= maxGuesses) {
            continueGuessing = false;
            break;
         }

         guessCount++;
         console.log(`Processing guess ${guessCount}/${maxGuesses}: ${suggestion.word} (${suggestion.confidence})`);

         // Broadcast the guess message
         const guessMessage = {
            type: 'guess',
            content: suggestion.word,
            team,
            timestamp: Date.now()
         };

         gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(guessMessage));
            }
         });

         // Update game state with the guess
         const updatedGame = await storage.getGame(gameId);
         if (updatedGame) {
            const newRevealedCards = [...(updatedGame.revealedCards || []), suggestion.word];
            await storage.updateGame(gameId, {
              revealedCards: newRevealedCards,
              gameHistory: [
                ...(updatedGame.gameHistory || []),
                {
                  type: "guess",
                  turn: team as "red" | "blue",
                  content: `${team.toUpperCase()} team guessed: ${suggestion.word}`,
                  timestamp: Date.now()
                }
              ]
            });

            // If the guessed word is the assassin, end discussion with a loss adjustment.
            if (suggestion.word === updatedGame.assassin) {
              await storage.updateGame(gameId, {
                gameState: team === 'red' ? "blue_win" : "red_win"
              });
              continueGuessing = false;
              break;
            }
            // If the guess is wrong (belongs to neutral or opposing team), end turn.
            else if (
              (team === "red" && !updatedGame.redTeam.includes(suggestion.word)) ||
              (team === "blue" && !updatedGame.blueTeam.includes(suggestion.word))
            ) {
              continueGuessing = false;
              break;
            }
            // Otherwise, correct guess: continue guessing if more high-confidence suggestions remain.
         }
      }
  
      // Add a short delay before next round of discussion messages
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    gameRoom.aiDiscussionInProgress = false;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Initialize WebSocket server
  const wss = new WebSocketServer({ 
    server: httpServer, 
    path: '/ws',
  });

  const connections = new Map<WebSocket, { 
    gameId: number; 
    team: string; 
    player?: AIModel;
    connectionTime: number;
    clientId: string;
  }>();

  // Track client IDs to prevent duplicates
  const activeClients = new Map<string, WebSocket>();

  wss.on('connection', (ws: WebSocket) => {
    const clientIp = (ws as any)._socket.remoteAddress;
    
    const attempts = connectionAttempts.get(clientIp) || 0;
    
    if (attempts > 5) {  // Limit connection attempts
      ws.close();
      return;
    }
    
    connectionAttempts.set(clientIp, attempts + 1);

    // Track new connection
    activeConnections.add(ws);

    ws.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === 'join') {
          // Only allow connections for the active game.
          if (latestGameId === null || data.gameId !== latestGameId) {
            console.log(`Rejecting connection to game ${data.gameId}, latest game is ${latestGameId}`);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'This game is no longer active.'
            }));
            ws.close();
            return;
          }

          // Rate limiting
          const lastConnectionTime = clientConnectionTimes.get(data.clientId);
          const now = Date.now();
          if (lastConnectionTime && now - lastConnectionTime < RATE_LIMIT.COOLDOWN_MS) {
            ws.close();
            return;
          }
          clientConnectionTimes.set(data.clientId, now);

          // Check if this client already has a connection
          const existingWs = activeClients.get(data.clientId);
          if (existingWs && existingWs !== ws) {
            // Close the existing connection
            existingWs.close();
            activeClients.delete(data.clientId);
            
            // Clean up from connections map
            if (connections.has(existingWs)) {
              const oldConn = connections.get(existingWs)!;
              const oldGameRoom = gameDiscussions.get(oldConn.gameId);
              if (oldGameRoom) {
                oldGameRoom.clients.delete(existingWs);
              }
              connections.delete(existingWs);
            }
          }

          const gameRoom = initializeGameRoom(data.gameId);
          const team = data.team as "red" | "blue";
          const model = data.player as AIModel;

          // Check if this is an AI model trying to join
          if (VALID_MODELS.includes(model)) {
            if (!canAddModelToGame(gameRoom, team, model)) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Cannot add more AI models to this game or team'
              }));
              ws.close();
              return;
            }
            gameRoom.teamModels[team].add(model);
          }

          // Remove existing connection if any
          if (connections.has(ws)) {
            const oldConn = connections.get(ws)!;
            const oldGameRoom = gameDiscussions.get(oldConn.gameId);
            if (oldGameRoom) {
              oldGameRoom.clients.delete(ws);
              // Remove model from old game if it was an AI
              if (VALID_MODELS.includes(oldConn.player as AIModel)) {
                oldGameRoom.teamModels[oldConn.team as "red" | "blue"].delete(oldConn.player as AIModel);
              }
            }
          }
          
          // Add new connection
          connections.set(ws, { 
            gameId: data.gameId, 
            team, 
            player: model || 'human',
            connectionTime: Date.now(),
            clientId: data.clientId
          });
          activeClients.set(data.clientId, ws);
          gameRoom.clients.add(ws);
          
          console.log(`Team ${team} joined game ${data.gameId}`);
        }

        if (data.type === 'discussion' && data.gameId) {
          const gameRoom = gameDiscussions.get(data.gameId);
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
      if (connections.has(ws)) {
        const conn = connections.get(ws)!;
        activeClients.delete(conn.clientId);
        const gameRoom = gameDiscussions.get(conn.gameId);
        if (gameRoom) {
          gameRoom.clients.delete(ws);
          // Remove AI model from game when disconnecting
          if (VALID_MODELS.includes(conn.player as AIModel)) {
            gameRoom.teamModels[conn.team as "red" | "blue"].delete(conn.player as AIModel);
          }
        }
        connections.delete(ws);
      }
      activeConnections.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  function canAddModelToGame(gameRoom: typeof gameDiscussions extends Map<any, infer T> ? T : never,
    team: "red" | "blue",
    model: AIModel
  ): boolean {
    const totalModels = gameRoom.teamModels.red.size + gameRoom.teamModels.blue.size;
    const teamModels = gameRoom.teamModels[team];
    const recentConnections = Array.from(connections.entries()) as [WebSocket, {
      gameId: number;
      team: string;
      connectionTime: number;
    }][];
    const recentTeamConnections = recentConnections
      .filter(([_, conn]) => conn.team === team);
    return totalModels < MAX_MODELS_PER_GAME && 
           teamModels.size < MAX_MODELS_PER_TEAM &&
           !teamModels.has(model) &&
           recentConnections.length < CONNECTION_LIMITS.CONNECTIONS_PER_GAME &&
           recentTeamConnections.length < CONNECTION_LIMITS.CONNECTIONS_PER_TEAM;
  }

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

      // Store the clue and trigger AI discussion
      const gameRoom = gameDiscussions.get(game.id);
      if (gameRoom) {
        const team = isRedTurn ? "red" : "blue";
        gameRoom.lastSpymasterClue.set(team, clue);

        // Broadcast clue to all clients
        const clueMessage = {
          type: 'discussion',
          content: `Spymaster gives clue: ${clue.word} (${clue.number})`,
          team,
          player: currentSpymaster,
          timestamp: Date.now()
        };

        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(clueMessage));
          }
        });

        // Start AI discussion
        const aiPlayers = team === 'red'
          ? game.redPlayers.filter(p => p !== 'human' && p !== game.redSpymaster)
          : game.bluePlayers.filter(p => p !== 'human' && p !== game.blueSpymaster);

        if (aiPlayers.length > 0) {
          handleAIDiscussion(game.id, team, clue, aiPlayers as AIModel[]);
        }
      }

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

      // Get discussion from AI
      const discussion = await discussAndVote(
        model as AIModel,
        team,
        game.words,
        clue,
        game.teamDiscussion || [],
        game.gameHistory || [],
        game.revealedCards || []
      );

      const formattedMessage = formatDiscussionMessage(
        model as AIModel, 
        discussion.message, 
        discussion.confidence, 
        discussion.suggestedWord
      );

      const newDiscussion = {
        team,
        player: model,
        message: formattedMessage,
        confidence: discussion.confidence,
        suggestedWord: discussion.suggestedWord,
        timestamp: Date.now()
      };

      // Update game state with new discussion message
      await storage.updateGame(game.id, {
        teamDiscussion: [
          ...(game.teamDiscussion || []),
          newDiscussion
        ]
      });

      // Broadcast message to all clients
      const gameRoom = gameDiscussions.get(game.id);
      if (gameRoom) {
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'discussion',
              team,
              player: model,
              content: formattedMessage,
              timestamp: Date.now()
            }));
          }
        });
      }

      res.json({
        ...newDiscussion,
        success: true
      });
    } catch (error: any) {
      console.error("Error in AI discussion:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/games/:id", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const updates: Partial<Game> = {};

      // When a new clue is given
      if (req.body.clue) {
        const gameRoom = gameDiscussions.get(game.id);
        if (gameRoom) {
          const team = game.currentTurn === "red_turn" ? "red" : "blue";
          gameRoom.lastSpymasterClue.set(team, req.body.clue);

          // Start AI discussion immediately after clue
          const aiPlayers = team === 'red'
            ? game.redPlayers.filter(p => p !== 'human' && p !== game.redSpymaster)
            : game.bluePlayers.filter(p => p !== 'human' && p !== game.blueSpymaster);

          if (aiPlayers.length > 0) {
            handleAIDiscussion(game.id, team, req.body.clue, aiPlayers as AIModel[]);
          }
        }
      }

      if (req.body.revealedCards) {
        const newCard = req.body.revealedCards[req.body.revealedCards.length - 1];
        const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";

        let result: "correct" | "wrong" | "assassin";
        if (newCard === game.assassin) {
          result = "assassin";
          updates.gameState = game.currentTurn === "red_turn" ? "blue_win" : "red_win";
          updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
        } else if (
          (game.currentTurn === "red_turn" && game.redTeam.includes(newCard)) ||
          (game.currentTurn === "blue_turn" && game.blueTeam.includes(newCard))
        ) {
          result = "correct";
        } else {
          result = "wrong";
          updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
        }

        // Broadcast the guess result to all clients
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'guess',
              team: currentTeam,
              word: newCard,
              result,
              timestamp: Date.now()
            }));
          }
        });

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

        if (game.redTeam.every((word: string) => req.body.revealedCards?.includes(word))) {
          updates.gameState = "red_win";
        } else if (game.blueTeam.every((word: string) => req.body.revealedCards?.includes(word))) {
          updates.gameState = "blue_win";
        }
      }

      if (req.body.currentTurn) {
        updates.currentTurn = req.body.currentTurn;
        updates.teamDiscussion = [];
        updates.consensusVotes = [];

        // Clear spymaster clue when turn changes
        const gameRoom = gameDiscussions.get(game.id);
        if (gameRoom) {
          gameRoom.lastSpymasterClue.clear();
        }
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
        player: model,
        word,
        approved: vote.approved,
        timestamp: Date.now()
      };

      const updatedVotes = game.consensusVotes 
        ? [...game.consensusVotes, newVote]
        : [newVote];

      await storage.updateGame(game.id, {
        consensusVotes: updatedVotes
      });

      const teamAIPlayers = currentTeamPlayers.filter(
        (p: string) => p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
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
      latestGameId = game.id;

      // Clean up old game state without terminating connections
      for (const [oldGameId] of gameDiscussions) {
        if (oldGameId !== game.id) {
          const gameRoom = gameDiscussions.get(oldGameId);
          if (gameRoom) {
            gameRoom.teamModels.red.clear();
            gameRoom.teamModels.blue.clear();
            gameRoom.activeTeams.clear();
            gameRoom.lastSpymasterClue.clear();
            gameRoom.aiDiscussionInProgress = false;
          }
          gameDiscussions.delete(oldGameId);
        }
      }

      // Initialize new game room
      initializeGameRoom(game.id);

      // Notify clients about new game
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            type: 'newGame',
            gameId: game.id
          }));
        }
      });

      res.json(game);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/games/:id/spymaster", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      // Add team information to each word
      const wordInfo = game.words.map(word => {
        let team: 'red' | 'blue' | 'neutral' | 'assassin' = 'neutral';
        if (game.redTeam.includes(word)) team = 'red';
        if (game.blueTeam.includes(word)) team = 'blue';
        if (game.assassin === word) team = 'assassin';

        return {
          word,
          team,
          revealed: game.revealedCards?.includes(word) || false
        };
      });

      res.json({
        words: wordInfo,
        currentTurn: game.currentTurn,
        redScore: game.redScore || 0,
        blueScore: game.blueScore || 0
      });
    } catch (error: any) {
      console.error("Error in spymaster view:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/reset", async (req, res) => {
    try {
      // Don't close connections, just reset game state
      gameDiscussions.forEach(gameRoom => {
        gameRoom.teamModels.red.clear();
        gameRoom.teamModels.blue.clear();
        gameRoom.activeTeams.clear();
        gameRoom.lastSpymasterClue.clear();
        gameRoom.aiDiscussionInProgress = false;
      });
      
      gameDiscussions.clear();
      
      // Notify clients of reset
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'reset' }));
        }
      });

      res.json({ message: "Reset complete" });
    } catch (error) {
      res.status(500).json({ error: "Reset failed" });
    }
  });

  app.delete("/api/games/:id", async (req, res) => {
    try {
      const gameId = Number(req.params.id);
      
      // Clean up WebSocket connections for this game
      const gameRoom = gameDiscussions.get(gameId);
      if (gameRoom) {
        // Close all connections for this game
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'gameDeleted' }));
            client.close();
          }
        });

        // Remove all AI models
        gameRoom.teamModels.red.clear();
        gameRoom.teamModels.blue.clear();

        // Clean up game state
        gameDiscussions.delete(gameId);
      }

      // Remove all connections associated with this game
      for (const [ws, conn] of connections.entries()) {
        if (conn.gameId === gameId) {
          connections.delete(ws);
          activeConnections.delete(ws);
        }
      }

      // Delete from storage
      await storage.deleteGame(gameId);

      res.json({ message: "Game deleted successfully" });
    } catch (error) {
      console.error("Error deleting game:", error);
      res.status(500).json({ error: "Failed to delete game" });
    }
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
  });

  return httpServer;
}