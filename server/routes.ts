import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { 
  getSpymasterClue, 
  getGuesserMove, 
  discussAndVote, 
  makeAgentDecision,
  getMetaDecision,
  formatDiscussionMessage,
  updateTeamMemory,
  backgroundSpymasterThinking,
  debouncedBackgroundThinking
} from "./lib/ai-service";
import {
  startSpymasterBackgroundThinking,
  stopSpymasterBackgroundThinking,
  restartAllSpymasterThinking
} from "./lib/spymaster-enhancement";
import { updateTurnResults } from "./lib/game-memory";
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

const MAX_MODELS_PER_GAME = 8;  // Maximum total AI models per game
const MAX_MODELS_PER_TEAM = 4;  // Maximum AI models per team

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

// Helper function to handle guesses from AI teams
async function handleGuess(gameId: number, team: string, word: string): Promise<"correct" | "wrong" | "assassin"> {
  const game = await storage.getGame(gameId);
  if (!game) throw new Error("Game not found");
  
  // Skip if word is already revealed
  if (game.revealedCards?.includes(word)) {
    return "wrong"; // Treat as wrong guess if word is already revealed
  }
  
  // Update revealed cards
  const newRevealedCards = [...(game.revealedCards || []), word];
  
  // Determine the result of the guess
  let result: "correct" | "wrong" | "assassin";
  let updates: any = { 
    revealedCards: newRevealedCards
    // CRITICAL FIX: Do NOT reset turn timer when guessing - this will be set only for wrong guesses
    // This ensures the timer continues running during meta decisions after correct guesses
  };
  
  if (word === game.assassin) {
    result = "assassin";
    updates.gameState = team === "red" ? "blue_win" : "red_win";
    updates.currentTurn = team === "red" ? "blue_turn" : "red_turn";
  } else if (
    (team === "red" && game.redTeam.includes(word)) ||
    (team === "blue" && game.blueTeam.includes(word))
  ) {
    // Team guessed their own word correctly
    result = "correct";
    if (game.redTeam.includes(word)) {
      updates.redScore = (game.redScore || 0) + 1;
    } else if (game.blueTeam.includes(word)) {
      updates.blueScore = (game.blueScore || 0) + 1;
    }
    // CRITICAL FIX: Do NOT change turn on correct guesses - allow team to continue guessing
  } else {
    // Wrong guess: either neutral word or opponent's word
    result = "wrong";
    
    // CRITICAL: Always change turn for neutral and opponent's words
    updates.currentTurn = team === "red" ? "blue_turn" : "red_turn";
    
    // Explicitly set the turn reason for detailed logs
    const isNeutralWord = !game.redTeam.includes(word) && !game.blueTeam.includes(word) && word !== game.assassin;
    const isOpponentWord = (team === "red" && game.blueTeam.includes(word)) || (team === "blue" && game.redTeam.includes(word));
    updates.turnChangeReason = isNeutralWord ? "neutral_word" : (isOpponentWord ? "opponent_word" : "wrong_guess");
    
    // Reset the turn timer explicitly for the next team
    updates.currentTurnStartTime = new Date();
    
    // If they revealed opposing team's word, that team gets a point
    if (isOpponentWord) {
      if (game.redTeam.includes(word)) {
        updates.redScore = (game.redScore || 0) + 1;
      } else if (game.blueTeam.includes(word)) {
        updates.blueScore = (game.blueScore || 0) + 1;
      }
    }
  }
  
  // Get the latest clue to reference in history
  const clueContent = game.gameHistory?.filter(h => h.type === "clue")?.pop()?.content || "";
  
  // Create the history entry
  const historyEntry = {
    type: "guess",
    turn: team,
    content: `${team.toUpperCase()} team guessed: ${word} (${result})`,
    timestamp: Date.now(),
    word: word,
    result: result,
    relatedClue: clueContent
  };
  
  updates.gameHistory = [...(game.gameHistory || []), historyEntry];
  
  // CRITICAL FIX: Also add a discussion message about the correct guess
  // so it appears prominently in the team chat
  if (result === "correct") {
    const discussionEntry = {
      team,
      player: 'Game',
      message: `🎯 CORRECT! ${team.toUpperCase()} team guessed "${word}" correctly!`,
      timestamp: Date.now(),
      isGameMessage: true,
      isCorrectGuess: true
    };
    
    updates.teamDiscussion = [
      ...(game.teamDiscussion || []),
      discussionEntry
    ];
  }
  
  // Update game state
  await storage.updateGame(gameId, updates);
  
  // Update game memory
  try {
    updateTurnResults(
      gameId, 
      team as "red" | "blue", 
      word, 
      result,
      clueContent ? { 
        word: clueContent.split(' ')[0], 
        number: parseInt(clueContent.match(/\((\d+)\)/)?.[1] || "0") 
      } : undefined
    );
  } catch (memError) {
    console.error("Error updating game memory:", memError);
  }
  
  // Broadcast the guess to all clients
  const gameRoom = gameDiscussions.get(gameId);
  if (gameRoom) {
    // Send guess result
    gameRoom.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'guess',
          team,
          word,
          result,
          timestamp: Date.now()
        }));
      }
    });
    
    // If turn is changing, send a turn change event
    if (result === "wrong" || result === "assassin") {
      const nextTurn = team === "red" ? "blue" : "red";
      
      // Determine specific reason for turn change for better client handling
      const isNeutralWord = !game.redTeam.includes(word) && !game.blueTeam.includes(word) && word !== game.assassin;
      const isOpponentWord = (team === "red" && game.blueTeam.includes(word)) || (team === "blue" && game.redTeam.includes(word));
      
      const turnChangeReason = result === "assassin" ? 'assassin' : 
                            isNeutralWord ? 'neutral_word' :
                            isOpponentWord ? 'opponent_word' : 'wrong_guess';
      
      // Immediately broadcast turn change to all clients
      gameRoom.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'turn_change',
            from: team,
            to: nextTurn,
            reason: turnChangeReason,
            timestamp: Date.now(),
            // Include word that caused turn change for clearer messages
            word: word,
            forced: true // Signal this is a forced turn change
          }));
        }
      });
    }
  }
  
  return result;
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
    
    // Start background thinking for both spymasters when a new game room is created
    // This helps spymasters prepare better clues by thinking continuously
    restartAllSpymasterThinking(gameId).catch(err => {
      console.error(`Error starting spymaster background thinking for game ${gameId}:`, err);
    });
  }
  return gameDiscussions.get(gameId)!;
}

const handleAIDiscussion = async (
  gameId: number,
  teamPlayers: string[],
  lastClue: {word: string, number: number} | null, 
  teamColor: "red" | "blue",
  isFirstRound = false
) => {
  console.log(`🎮 Starting AI discussion for team ${teamColor} with ${teamPlayers.length} operatives`);
  const gameRoom = gameDiscussions.get(gameId);
  
  // CRITICAL FIX: Allow discussion even if another is in progress when this is called 
  // directly from the spymaster clue endpoint - this ensures operatives always discuss
  // after a spymaster gives a clue
  if (!gameRoom) {
    console.log('❌ Discussion blocked - gameRoom missing');
    return;
  }
  
  // Only block if a discussion is already in progress and this isn't the first round after a clue
  if (gameRoom.aiDiscussionInProgress && !isFirstRound) {
    console.log('❌ Discussion skipped - another discussion already in progress');
    return;
  }

  // Reset discussion state and mark as in progress
  console.log(`🎯 Starting AI team discussion for ${teamColor} team with clue: ${lastClue?.word || 'none'}`);
  gameRoom.aiDiscussionInProgress = true;
  
  let guessCount = 0;
  const maxGuesses = lastClue?.number ? lastClue.number + 1 : 1;
  let continueGuessing = true;
  let discussionRound = 1;
  let votingTriggered = false;
  
  try {
    // First round of discussion
    const game = await storage.getGame(gameId);
    if (!game) {
      console.log("Game not found");
      gameRoom.aiDiscussionInProgress = false;
      return;
    }
    
    // Process each AI agent sequentially for immediate messaging
    for (const model of teamPlayers) {
      try {
        console.log(`Getting discussion from ${model} for round ${discussionRound}`);
        
        // Get the AI response - fix the call to match the function signature in ai-service.ts
        const discussion = await discussAndVote(
          model as AIModel,
          teamColor,
          game.words,
          lastClue || { word: "", number: 0 },
          game.teamDiscussion || [],
          game.gameHistory || [],
          game.revealedCards || [],
          discussionRound,
          "team member",
          teamColor === "red" ? game.redScore || 0 : game.blueScore || 0,
          teamColor === "red" ? game.blueScore || 0 : game.redScore || 0,
          new Date(),
          60,
          guessCount,
          gameId
        );
        
        if (!discussion) {
          console.error(`Failed to get discussion from ${model}`);
          continue;
        }
        
        // Create discussion entry
        const newDiscussion = {
          team: teamColor,
          player: model,
          message: discussion.message,
          confidences: Array.isArray(discussion.confidences) ? discussion.confidences : 
                      discussion.suggestedWords?.map((_, i) => 
                        Math.max(0.2, (discussion.confidence || 0.5) * (1 - i * 0.15))
                      ) || [],
          suggestedWords: discussion.suggestedWords || (discussion.suggestedWord ? [discussion.suggestedWord] : []),
          risk: discussion.risk,
          timestamp: Date.now(),
          round: discussionRound,
          isVoting: Boolean(discussion.action === "guess" || discussion.action === "end_turn"),
          voteType: discussion.action === "end_turn" ? "end_turn" : "continue"
        };
        
        // Immediately update the database with this message
        await storage.updateGame(gameId, {
          teamDiscussion: [
            ...(await storage.getGame(gameId))?.teamDiscussion || [],
            newDiscussion
          ]
        });
        
        // Broadcast to all clients immediately - ensure proper field mapping
        broadcastGameEvent(gameId, {
          type: 'discussion',
          team: teamColor,
          player: model,
          content: discussion.message,
          message: discussion.message, // Include both fields for compatibility
          confidences: newDiscussion.confidences,
          suggestedWords: newDiscussion.suggestedWords,
          isVoting: newDiscussion.isVoting,
          voteType: newDiscussion.voteType,
          timestamp: newDiscussion.timestamp,
          timeInfo: discussion.timeInfo
        });
        
        // Short delay for natural conversation flow
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (modelError) {
        console.error(`Error processing model ${model}:`, modelError);
      }
    }
    
    // Multiple rounds of discussion - do 2 complete rounds minimum
    if (discussionRound < 2) {
      discussionRound++;
      
      // Get updated game with the latest discussion
      const updatedGame = await storage.getGame(gameId);
      if (updatedGame) {
        // Wait a bit to simulate thinking time between rounds
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Start another round of discussion
        for (const model of teamPlayers) {
          try {
            console.log(`Round ${discussionRound}: Getting discussion from ${model}`);
            
            // Get the AI response for this round - fix the call to match the function signature
            const discussion = await discussAndVote(
              model as AIModel,
              teamColor,
              updatedGame.words,
              lastClue || { word: "", number: 0 },
              updatedGame.teamDiscussion || [],
              updatedGame.gameHistory || [],
              updatedGame.revealedCards || [],
              discussionRound,
              "team member",
              teamColor === "red" ? updatedGame.redScore || 0 : updatedGame.blueScore || 0,
              teamColor === "red" ? updatedGame.blueScore || 0 : updatedGame.redScore || 0,
              new Date(),
              60,
              guessCount,
              gameId
            );
            
            if (!discussion) {
              console.error(`Failed to get round ${discussionRound} discussion from ${model}`);
              continue;
            }
            
            // Create discussion entry with voting flag based on action
            const shouldTriggerVoting = discussion.action === "guess" || discussion.action === "end_turn";
            
            const newDiscussion = {
              team: teamColor,
              player: model,
              message: discussion.message,
              confidences: Array.isArray(discussion.confidences) ? discussion.confidences : 
                        discussion.suggestedWords?.map((_, i) => 
                          Math.max(0.2, (discussion.confidence || 0.5) * (1 - i * 0.15))
                        ) || [],
              suggestedWords: discussion.suggestedWords || (discussion.suggestedWord ? [discussion.suggestedWord] : []),
              risk: discussion.risk,
              timestamp: Date.now(),
              round: discussionRound,
              isVoting: shouldTriggerVoting,
              voteType: discussion.action === "end_turn" ? "end_turn" : "continue"
            };
            
            // Save and broadcast as before
            const currentGameState = await storage.getGame(gameId);
            await storage.updateGame(gameId, {
              teamDiscussion: [
                ...(currentGameState?.teamDiscussion || []),
                newDiscussion
              ]
            });
            
            // Broadcast the second round message - ensure proper field mapping
            broadcastGameEvent(gameId, {
              type: 'discussion',
              team: teamColor,
              player: model,
              content: discussion.message,
              message: discussion.message, // Include both fields for compatibility
              confidences: newDiscussion.confidences,
              suggestedWords: newDiscussion.suggestedWords,
              isVoting: newDiscussion.isVoting,
              voteType: newDiscussion.voteType,
              timestamp: newDiscussion.timestamp,
              timeInfo: discussion.timeInfo
            });
            
            // If voting is triggered, make note so we can handle it after all agents have spoken
            if (shouldTriggerVoting) {
              votingTriggered = true;
            }
            
            // Short delay between agents
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (modelError) {
            console.error(`Error processing model ${model} in round ${discussionRound}:`, modelError);
          }
        }
      }
    }
    
    // Final voting round - force a conclusion if a clear favorite word emerged
    const updatedGame = await storage.getGame(gameId);
    if (updatedGame && updatedGame.teamDiscussion) {
      // Now process word voting if any agent suggested concrete words
      const currentTeamDiscussion = updatedGame.teamDiscussion.filter(msg => msg.team === teamColor);
      
      // Get all suggested words with frequency count
      const wordSuggestions = new Map<string, { count: number, model: string }>();
      
      currentTeamDiscussion.forEach(msg => {
        if (msg.suggestedWords && msg.suggestedWords.length > 0) {
          msg.suggestedWords.forEach(word => {
            if (!wordSuggestions.has(word)) {
              wordSuggestions.set(word, { count: 0, model: msg.player });
            }
            const data = wordSuggestions.get(word)!;
            data.count++;
          });
        }
      });
      
      // Find the most frequently suggested word
      let bestWord = '';
      let bestCount = 0;
      
      wordSuggestions.forEach((data, word) => {
        if (data.count > bestCount) {
          bestCount = data.count;
          bestWord = word;
        }
      });
      
      // If a clear favorite emerged and not already voted on
      if (bestWord && bestCount >= teamPlayers.length / 2) {
        console.log(`Creating automatic vote for most popular word: ${bestWord}`);
        
        // First model votes for the word to kickstart the voting process
        if (teamPlayers.length > 0) {
          const firstVoter = teamPlayers[0];
          
          try {
            // Submit vote on behalf of first AI
            const voteResult = await makeAgentDecision(
              firstVoter as AIModel,
              teamColor,
              bestWord,
              lastClue || { word: "", number: 0 },
              updatedGame.teamDiscussion || [],
              updatedGame.words.filter(w => !(updatedGame.revealedCards || []).includes(w)),
              updatedGame.revealedCards || [],
              guessCount,
              gameId
            );
            
            // Create and add vote
            const autoVote: ConsensusVote = {
              team: teamColor,
              player: firstVoter,
              word: bestWord,
              approved: voteResult.decision === "guess",
              confidence: voteResult.confidence,
              timestamp: Date.now(),
              reason: voteResult.explanation,
              relatedClue: lastClue ? `${lastClue.word} (${lastClue.number})` : undefined
            };
            
            // Save vote
            await storage.updateGame(gameId, {
              consensusVotes: [
                ...(updatedGame.consensusVotes || []),
                autoVote
              ]
            });
            
            // Broadcast vote to all clients
            broadcastGameEvent(gameId, {
              type: 'word_votes',
              team: teamColor,
              words: [{
                word: bestWord,
                votes: 1,
                percentage: Math.round((1 / teamPlayers.length) * 100),
                voters: [{ player: firstVoter, confidence: voteResult.confidence }]
              }],
              totalVoters: teamPlayers.length,
              timestamp: Date.now()
            });
          } catch (voteError) {
            console.error(`Error creating automatic vote for ${bestWord}:`, voteError);
          }
        }
      } else if (votingTriggered) {
        console.log("No clear favorite word emerged, but voting was triggered. Allowing manual voting.");
        // We'll let the UI handle the manual voting process
      }
    }
    
  } catch (error) {
    console.error(`Error in AI discussion:`, error);
  } finally {
    gameRoom.aiDiscussionInProgress = false;
    console.log(`🏁 AI discussion for game ${gameId}, team ${teamColor} complete after ${discussionRound} rounds`);
  }
};

// Function to broadcast events to all clients in a game room
function broadcastGameEvent(gameId: number, data: any) {
  const gameRoom = gameDiscussions.get(gameId);
  if (gameRoom?.clients) {
    // Ensure the data has a timestamp
    if (!data.timestamp) {
      data.timestamp = Date.now();
    }
    
    // Convert to JSON once for all clients
    const messageData = JSON.stringify(data);
    console.log(`🔊 Broadcasting event type="${data.type}" to ${gameRoom.clients.size} clients`);
    
    // Send to all connected clients
    let sentCount = 0;
    gameRoom.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageData);
        sentCount++;
      }
    });
    
    console.log(`📢 Event sent to ${sentCount} connected clients`);
  } else {
    console.log(`❌ No game room found for game ${gameId} - event not broadcast`);
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
    uniqueId?: string; // Add uniqueId for preventing duplicate votes
    modelWithId?: string; // Full model ID with unique identifier
    connectionTime: number;
    clientId: string;
  }>();

  // Track client IDs to prevent duplicates
  const activeClients = new Map<string, WebSocket>();
  
  // Function to get the appropriate icon for a model
  const getModelIcon = (model: string): string => {
    // Extract base model name from any format (model#uniqueId, model-timestamp, etc.)
    let baseModel = model;
    
    // Handle various formats of model IDs
    if (typeof model === 'string') {
      if (model.includes('#')) {
        baseModel = model.split('#')[0];
      } else if (model.includes('-')) {
        const parts = model.split('-');
        if (VALID_MODELS.includes(parts[0] as any)) {
          baseModel = parts[0];
        }
      }
    }
    
    // Complete map of models to visual icons
    const iconMap: {[key: string]: string} = {
      // AI Models
      'gpt-4o': '🟢', // OpenAI - Green
      'claude-3-5-sonnet-20241022': '🟣', // Anthropic - Purple
      'grok-2-1212': '🔴', // Grok - Red
      'gemini-1.5-pro': '🔵', // Google - Blue
      'llama-7b': '🟡', // Meta - Yellow
      
      // Human users
      'human': '👤', // Human player
      
      // System
      'Game': '🎮'  // Game system messages
    };
    
    // Return the icon or default to robot icon if unknown
    return iconMap[baseModel] || '🤖';
  };

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
          
          // Handle unique model IDs for preventing duplicate votes - use 5-digit format
          const uniqueId = data.uniqueId || Math.floor(10000 + Math.random() * 90000).toString();
          let modelWithId = model;
          
          // Add unique ID to model name for tracking
          if (model && uniqueId) {
            modelWithId = `${model}#${uniqueId}`;
            console.log(`🔑 Created unique model identifier for WebSocket: ${modelWithId}`);
          }

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
            
            // Store the model with its unique ID to prevent duplicate voting
            gameRoom.teamModels[team].add(modelWithId);
            
            // Send model icon information back to the client for display
            ws.send(JSON.stringify({
              type: 'model_info',
              model,
              uniqueId,
              modelId: modelWithId,
              team,
              icon: getModelIcon(model) // Add the icon for this model
            }));
          }

          // Remove existing connection if any
          if (connections.has(ws)) {
            const oldConn = connections.get(ws)!;
            const oldGameRoom = gameDiscussions.get(oldConn.gameId);
            if (oldGameRoom) {
              oldGameRoom.clients.delete(ws);
              // Remove model from old game if it was an AI
              if (VALID_MODELS.includes(oldConn.player as AIModel)) {
                // First try to delete using the full modelWithId if available
                if (oldConn.modelWithId) {
                  oldGameRoom.teamModels[oldConn.team as "red" | "blue"].delete(oldConn.modelWithId);
                }
                // Also delete using the base model name for backward compatibility
                oldGameRoom.teamModels[oldConn.team as "red" | "blue"].delete(oldConn.player as AIModel);
              }
            }
          }
          
          // Add new connection with unique ID information
          connections.set(ws, { 
            gameId: data.gameId, 
            team, 
            player: model || 'human',
            uniqueId: uniqueId, // Store the unique ID for this model instance
            modelWithId: modelWithId, // Store the full model identifier
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
            // First, update the game database with the message
            const game = await storage.getGame(data.gameId);
            if (game) {
              const newDiscussion = {
                team: data.team,
                player: data.player || 'human',
                message: data.content,
                confidences: data.confidences || [data.confidence || 0.7],
                suggestedWords: data.suggestedWords || (data.suggestedWord ? [data.suggestedWord] : []),
                timestamp: Date.now()
              };
              
              // Save in database first
              await storage.updateGame(data.gameId, {
                teamDiscussion: [...(game.teamDiscussion || []), newDiscussion]
              });
              
              console.log(`💬 Saved discussion message from ${data.player || 'human'} to database`);
            }
            
            // Then broadcast to all clients
            const messageData = JSON.stringify({
              type: 'discussion',
              content: data.content,
              message: data.content, // Include both for compatibility
              team: data.team,
              player: data.player || 'human',
              confidences: data.confidences || [data.confidence || 0.7],
              suggestedWords: data.suggestedWords || (data.suggestedWord ? [data.suggestedWord] : []),
              timestamp: Date.now()
            });

            // Send to ALL clients, not just "other" clients
            gameRoom.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(messageData);
              }
            });
            
            console.log(`📢 Broadcast discussion message to ${gameRoom.clients.size} clients`);
          }
        }
        
        // Handle clearing discussion for a team when turn changes
        if (data.type === 'clear_discussion' && data.gameId && data.team) {
          console.log(`🧹 Clearing discussion for ${data.team} team in game ${data.gameId}`);
          
          const game = await storage.getGame(data.gameId);
          if (game) {
            // Filter out all discussions from the specified team
            const filteredDiscussion = (game.teamDiscussion || []).filter(msg => 
              msg.team !== data.team || msg.isTurnChange === true
            );
            
            // Save updated discussion
            await storage.updateGame(data.gameId, {
              teamDiscussion: filteredDiscussion,
              // Also clear all votes for this team
              consensusVotes: (game.consensusVotes || []).filter(v => v.team !== data.team),
              metaVotes: (game.metaVotes || []).filter(v => v.team !== data.team)
            });
            
            console.log(`✅ Successfully cleared ${data.team} team discussion. Remaining messages: ${filteredDiscussion.length}`);
            
            // Broadcast discussion cleared event
            const gameRoom = gameDiscussions.get(data.gameId);
            if (gameRoom?.clients) {
              gameRoom.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'discussion_cleared',
                    team: data.team,
                    timestamp: Date.now()
                  }));
                }
              });
            }
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
            // First try to delete using the full modelWithId if available
            if (conn.modelWithId) {
              console.log(`🔑 Removing model with unique ID: ${conn.modelWithId}`);
              gameRoom.teamModels[conn.team as "red" | "blue"].delete(conn.modelWithId);
            }
            // Also delete using the base model name for backward compatibility
            gameRoom.teamModels[conn.team as "red" | "blue"].delete(conn.player as AIModel);
          }
          
          // Check if this game room is now empty and clean up resources if so
          if (gameRoom.clients.size === 0) {
            console.log(`🛑 All clients disconnected from game ${conn.gameId} - stopping background thinking processes`);
            stopSpymasterBackgroundThinking(conn.gameId);
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

      // Make sure we have revealed cards info
      const revealedCards = game.revealedCards || [];
      
      console.log(`🧠 Getting spymaster clue for ${currentSpymaster} (team: ${isRedTurn ? "red" : "blue"})`);

      // Leverage our background thinking cache by default
      // This will automatically use a cached clue if one is available and still relevant
      const clue = await getSpymasterClue(
        currentSpymaster as AIModel,
        game.words,
        currentTeamWords,
        opposingTeamWords,
        game.assassin,
        game.gameHistory || [],
        game.gameState,
        game.redScore,
        game.blueScore,
        revealedCards,
        true // Use background thinking cache if available
      );
      
      console.log(`🎯 Spymaster ${currentSpymaster} provided clue: ${clue.word} (${clue.number})${clue.reasoning ? ' with reasoning' : ''}`);
      

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
        
        // Start background thinking for the opposing team's spymaster
        // This helps the opponent prepare a clue while the current team is playing
        const opposingTeam = isRedTurn ? "blue" : "red";
        startSpymasterBackgroundThinking(game.id, opposingTeam, false).catch(err => {
          console.error(`Error starting background thinking for opposing team ${opposingTeam}:`, err);
        });

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
          handleAIDiscussion(game.id, aiPlayers, clue, team, true);
        }
      }

      const historyEntry: GameHistoryEntry = {
        type: "clue",
        turn: isRedTurn ? "red" : "blue",
        content: `${clue.word} (${clue.number})`,
        timestamp: Date.now()
      };

      // Update the game state with the clue, reset turn timer, and add a discussion prompt
      await storage.updateGame(game.id, {
        gameHistory: game.gameHistory ? [...game.gameHistory, historyEntry] : [historyEntry],
        // CRITICAL: Reset turn timer when a clue is given
        currentTurnStartTime: new Date(),
        // Add a system message to team discussion to prompt operatives
        teamDiscussion: [
          ...(game.teamDiscussion || []),
          {
            team: isRedTurn ? "red" : "blue",
            player: "Game",
            message: `Spymaster has given the clue: ${clue.word} (${clue.number}). Team should discuss and vote on words to guess.`,
            timestamp: Date.now(),
            confidences: [1],
            suggestedWords: [],
            round: (game.teamDiscussion || [])
              .filter(d => d.team === (isRedTurn ? "red" : "blue"))
              .length + 1
          }
        ]
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
      // Get team information
      const isRedTeam = team === "red";
      const opposingTeam = isRedTeam ? "blue" : "red";
      const teamScore = isRedTeam ? game.redScore : game.blueScore;
      const opposingScore = isRedTeam ? game.blueScore : game.redScore;
      
      // Get guesses made for current clue
      const lastClueEntry = game.gameHistory?.filter(h => h.type === "clue")?.pop();
      const currentClueGuesses = (game.gameHistory || [])
        .filter(h => 
          h.type === "guess" && 
          h.turn === team && 
          h.relatedClue === lastClueEntry?.content
        ).length;

      const discussion = await discussAndVote(
        model as AIModel,
        team,
        game.words,
        clue,
        game.teamDiscussion || [],
        game.gameHistory || [],
        game.revealedCards || [],
        undefined, // conversation round
        "team member", // role
        teamScore,
        opposingScore,
        new Date(lastClueEntry?.timestamp || Date.now()),
        60, // turn time limit
        currentClueGuesses,
        game.id
      );

      const formattedMessage = formatDiscussionMessage(
        model as AIModel, 
        discussion.message, 
        discussion.confidences?.[0] || 0.5, 
        null, // No longer using suggestedWord
        discussion.suggestedWords
      );

      // Create the discussion message entry - with appropriate flags for voting
      // Ensure we always have properly formatted arrays for suggestedWords and confidences
      const suggestedWordsArray = Array.isArray(discussion.suggestedWords) && discussion.suggestedWords.length > 0
        ? discussion.suggestedWords 
        : (discussion.suggestedWord ? [discussion.suggestedWord] : []);

      // Ensure we have a confidences array that matches suggestedWords
      let confidencesArray = Array.isArray(discussion.confidences) && discussion.confidences.length > 0
        ? discussion.confidences
        : [];
      
      // If we have a primary confidence value, use it to populate the array
      if (suggestedWordsArray.length > 0 && (confidencesArray.length === 0 || confidencesArray.length < suggestedWordsArray.length)) {
        const baseConfidence = discussion.confidence || 0.8;
        confidencesArray = suggestedWordsArray.map((_, idx) => {
          // Scale confidence down for each subsequent word
          return Math.max(0.3, baseConfidence * (1 - idx * 0.15));
        });
      }

      // For single word scenarios, ensure it's still an array
      if (suggestedWordsArray.length === 0 && discussion.suggestedWord) {
        suggestedWordsArray.push(discussion.suggestedWord);
        confidencesArray.push(discussion.confidence || 0.8);
      }

      // Always mark messages with suggestions as voting-enabled
      const shouldEnableVoting = suggestedWordsArray.length > 0 || 
        discussion.action === "end_turn" || 
        discussion.action === "guess";

      console.log(`🔍 New discussion from ${model}:`, {
        hasWords: suggestedWordsArray.length > 0,
        words: suggestedWordsArray,
        confidences: confidencesArray,
        action: discussion.action,
        isVoting: shouldEnableVoting
      });

      const newDiscussion = {
        team,
        player: model,
        message: formattedMessage,
        confidences: confidencesArray,
        suggestedWords: suggestedWordsArray,
        risk: discussion.risk,
        timestamp: Date.now(),
        round: (game.teamDiscussion || [])
          .filter(d => d.team === team)
          .length + 1,
        // ALWAYS set isVoting flag for messages with suggestions
        isVoting: shouldEnableVoting,
        // Set the appropriate vote type 
        voteType: discussion.action === "end_turn" ? "end_turn" : "continue"
      };

      // Add transition logic to force voting after a certain number of messages
      const teamMessages = (game.teamDiscussion || []).filter(msg => msg.team === team);
      
      // If we have at least 3 messages from this team and no voting has started yet
      const hasVotingStarted = teamMessages.some(msg => msg.isVoting);
      const teamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      const isTeamComplete = teamMessages.filter(msg => 
        msg.round === newDiscussion.round // Same round
      ).length >= teamPlayers.length;
      
      // Force transition to voting state if needed
      if (!hasVotingStarted && isTeamComplete && discussion.suggestedWords?.length > 0) {
        newDiscussion.isVoting = true;
        // If agent suggested a word with high confidence, make it a word vote
        if (discussion.confidences && discussion.confidences[0] > 0.7) {
          newDiscussion.voteType = "continue";
        }
      }

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
        // Determine if we should force a vote after this message
        const shouldForceVoteTransition = 
          !gameRoom.aiDiscussionInProgress && // Not already in voting
          teamMessages.length >= 3 && // At least 3 messages
          !hasVotingStarted && // No voting has started
          suggestedWordsArray.length > 0; // Has suggestions
        
        // Ensure we're using the actual suggestedWordsArray and confidencesArray we constructed
        const messageToSend = {
          type: 'discussion',
          team,
          player: model,
          message: formattedMessage, // Fixed field name
          confidences: confidencesArray,
          suggestedWords: suggestedWordsArray,
          risk: discussion.risk || "Medium",
          timestamp: Date.now(),
          round: newDiscussion.round,
          // Either use the discussion's voting flag or force a transition if needed
          isVoting: shouldEnableVoting || shouldForceVoteTransition,
          voteType: newDiscussion.voteType,
          timeInfo: discussion.timeInfo || {
            turnStartTime: Date.now(),
            turnTimeLimit: 60,
            remainingTime: 60
          }
        };
        
        console.log('📤 Sending message to clients:', {
          player: model,
          suggestedWords: messageToSend.suggestedWords,
          confidences: messageToSend.confidences,
          isVoting: messageToSend.isVoting
        });
        
        console.log(`Broadcasting message with voting status: ${messageToSend.isVoting}`);
        
        // Send to all connected clients
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(messageToSend));
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

      // Check for forced turn changes from timer expiration
      const hasTimerExpiration = req.body._forceTimerSwitch === true || 
                               req.body.forceTimerExpiration === true ||
                               req.body._EMERGENCY_TURN_CHANGE === true;
      
      // Handle explicit turn changes with higher priority
      if (req.body.currentTurn && (req.body.currentTurn !== game.currentTurn || hasTimerExpiration)) {
        console.log(`🔄 TURN CHANGE via PATCH: ${game.currentTurn} → ${req.body.currentTurn}`);
        
        // Always update turn state in the database
        updates.currentTurn = req.body.currentTurn;
        
        // Always reset turn timer for the next team
        updates.currentTurnStartTime = new Date();
        
        // When turn changes, trigger background thinking for both teams
        // This is especially important for the team that's about to play
        const incomingTeam = req.body.currentTurn === "red_turn" ? "red" : "blue";
        const outgoingTeam = req.body.currentTurn === "red_turn" ? "blue" : "red";
        
        // Prioritize thinking for the team that's about to play
        startSpymasterBackgroundThinking(game.id, incomingTeam, false).catch(err => {
          console.error(`Error starting background thinking for incoming team ${incomingTeam}:`, err);
        });
        
        // Also let the other team think about their next move
        startSpymasterBackgroundThinking(game.id, outgoingTeam, true).catch(err => {
          console.error(`Error starting background thinking for outgoing team ${outgoingTeam}:`, err);
        });
        
        // Add history entry for forced timer changes
        if (hasTimerExpiration) {
          console.log(`⏰ TIMER EXPIRATION TURN CHANGE via PATCH`);
          const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
          
          updates.gameHistory = [
            ...(game.gameHistory || []),
            {
              type: "turn_end",
              turn: currentTeam,
              content: `${currentTeam.toUpperCase()} team's turn ended due to TIMER EXPIRATION (forced)`,
              timestamp: Date.now(),
              forced: true
            }
          ];
          
          // Broadcast turn change to all clients
          const gameRoom = gameDiscussions.get(game.id);
          if (gameRoom) {
            const nextTeam = currentTeam === "red" ? "blue" : "red";
            gameRoom.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'turn_change',
                  from: currentTeam,
                  to: nextTeam,
                  reason: 'time_expired',
                  timestamp: Date.now(),
                  forced: true,
                  highPriority: true,
                  source: 'patch_api'
                }));
              }
            });
          }
        }
      }

      // When a new clue is given
      if (req.body.clue) {
        const gameRoom = gameDiscussions.get(game.id);
        if (gameRoom) {
          const team = game.currentTurn === "red_turn" ? "red" : "blue";
          gameRoom.lastSpymasterClue.set(team, req.body.clue);

          // ALWAYS reset turn timer when a clue is given
          updates.currentTurnStartTime = new Date();

          // Start AI discussion immediately after clue
          const aiPlayers = team === 'red'
            ? game.redPlayers.filter(p => p !== 'human' && p !== game.redSpymaster)
            : game.bluePlayers.filter(p => p !== 'human' && p !== game.blueSpymaster);

          if (aiPlayers.length > 0) {
            handleAIDiscussion(game.id, aiPlayers, req.body.clue, team, true);
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
          // Score always goes to the team that OWNS the word
          if (game.redTeam.includes(newCard)) {
            // Red team's word was revealed
            updates.redScore = (game.redScore || 0) + 1;
            console.log(`Red team gets a point because their word "${newCard}" was revealed`);
          } else if (game.blueTeam.includes(newCard)) {
            // Blue team's word was revealed
            updates.blueScore = (game.blueScore || 0) + 1;
            console.log(`Blue team gets a point because their word "${newCard}" was revealed`);
          }
          
          // Only change turn if it was a wrong guess
          // CRITICAL FIX: Only change turn for wrong guesses
          if (
            // Determine if this is a wrong guess (not team's own word)
            (game.currentTurn === "red_turn" && !game.redTeam.includes(newCard)) ||
            (game.currentTurn === "blue_turn" && !game.blueTeam.includes(newCard))
          ) {
            result = "wrong";
            // Change turn for wrong guesses
            updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
          } else {
            // Correct guess - do NOT change turn (team continues)
            result = "correct";
          }
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

      const updatedGame = await storage.updateGame(game.id, updates);
      res.json(updatedGame);
    } catch (error: any) {
      console.error("Error in patch game:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/games/:id/ai/vote", async (req, res) => {
    // Log full poll info for debugging
    console.log(`📊 Received vote with poll data:`, {
      pollId: req.body.pollId,
      team: req.body.team,
      word: req.body.word,
      uniqueId: req.body.uniqueId,
      timestamp: Date.now()
    });
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, word, uniqueId } = req.body;

      if (!team) {
        return res.status(400).json({ error: "Team is required" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      // Get count of operatives (excluding spymaster) for more accurate voting
      const teamSpymaster = team === "red" ? game.redSpymaster : game.blueSpymaster;
      const operativesCount = currentTeamPlayers.filter(p => p !== teamSpymaster).length;
      console.log(`Team ${team} has ${operativesCount} operatives for vote calculation`);
      
      // Extract the base model name and uniqueId from the model parameter
      let baseModel = model;
      let modelUniqueId = uniqueId || ''; // Use provided uniqueId if available
      
      // Handle model#uniqueId format
      if (typeof model === 'string' && model.includes('#')) {
        const parts = model.split('#');
        baseModel = parts[0];
        // Only use the ID from the model parameter if no explicit uniqueId was provided
        if (!modelUniqueId) {
          modelUniqueId = parts[1];
        }
      } 
      // Handle older model-timestamp format for backward compatibility
      else if (typeof model === 'string' && model.includes('-')) {
        const parts = model.split('-');
        if (VALID_MODELS.includes(parts[0] as any)) {
          baseModel = parts[0];
          // Only use the ID from the model parameter if no explicit uniqueId was provided
          if (!modelUniqueId) {
            modelUniqueId = parts.slice(1).join('-');
          }
        }
      }
      
      console.log(`🔑 Vote request: model=${model}, baseModel=${baseModel}, uniqueId=${modelUniqueId}`);
      
      // Allow human votes without model validation
      // But validate AI models to ensure they're supported
      if (baseModel !== 'human' && baseModel !== 'Game' && (!baseModel || !VALID_MODELS.includes(baseModel as AIModel))) {
        return res.status(400).json({ error: "Invalid model" });
      }

      if (baseModel !== 'human' && baseModel !== 'Game' && !currentTeamPlayers.includes(baseModel)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      // ENHANCED: Create a unique identifier for each model to prevent duplicates
      // Use the provided unique ID or generate one if not provided
      const finalUniqueId = modelUniqueId || Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
      
      // Format the model ID with the unique identifier
      const modelWithId = modelUniqueId ? `${baseModel}#${finalUniqueId}` : baseModel;
      
      // Check if this model (without unique ID) has already voted for this word
      // We'll replace the vote with the higher confidence instead of rejecting it
      const existingVoteIndex = (game.consensusVotes || []).findIndex(v => 
        v.team === team && 
        v.word === word && 
        (v.player === model || 
         (typeof v.player === 'string' && 
          v.player.split('#')[0] === model))
      );
      
      const existingVote = existingVoteIndex !== -1 ? (game.consensusVotes || [])[existingVoteIndex] : null;
      
      console.log(`✅ Using model ID for vote: ${modelWithId} (unique ID: ${finalUniqueId})`);
      if (existingVote) {
        console.log(`🔄 Model ${model} already voted for word ${word}, will update with max confidence`);
      }
      

      const clueContent = game.gameHistory?.filter(h => h.type === "clue")?.pop()?.content || "";
      const clueMatch = clueContent.match(/^(.+?)\s*\((\d+)\)$/);
      const currentClue = clueMatch 
        ? { word: clueMatch[1], number: parseInt(clueMatch[2]) }
        : { word: "unknown", number: 1 };

      const availableWords = game.words.filter(w => !(game.revealedCards || []).includes(w));
      
      // Calculate current game state information for decision making
      const currentClueGuessCount = (game.gameHistory || [])
        .filter(h => 
          h.type === "guess" && 
          h.turn === team && 
          h.relatedClue === clueContent
        ).length;
      
      // Current score and remaining score to win
      const redRemainingScore = game.redTeam.length - (game.redScore || 0);
      const blueRemainingScore = game.blueTeam.length - (game.blueScore || 0);
      const teamRemainingScore = team === "red" ? redRemainingScore : blueRemainingScore;
      
      // Create the new vote object with the uniquified model ID
      let newVote: ConsensusVote;
      
      // Calculate adjusted confidence based on past guesses related to this clue
      const adjustConfidenceBasedOnPastGuesses = (baseConfidence: number) => {
        // Get all historical guesses
        const allGuesses = (game.gameHistory || []).filter(h => h.type === "guess");
        
        // Find any words previously guessed with this clue that were wrong
        const wrongGuessesForClue = allGuesses.filter(g => 
          g.relatedClue === clueContent && 
          g.result === "wrong");
          
        // If there are wrong guesses for this clue, this word is more likely to be right
        // (assuming spymaster intended it for this word instead)
        let confidenceMultiplier = 1.0;
        
        if (wrongGuessesForClue.length > 0) {
          // Each wrong guess increases confidence for remaining words
          confidenceMultiplier += wrongGuessesForClue.length * 0.15;
          
          console.log(`🔍 Found ${wrongGuessesForClue.length} wrong guesses for clue "${clueContent}", ` +
                    `adjusting confidence by multiplier ${confidenceMultiplier.toFixed(2)}`);
        }

        // Calculate adjusted confidence, capped at 0.99
        return Math.min(0.99, baseConfidence * confidenceMultiplier);
      };
      
      if (model === 'human') {
        // For human votes, create a direct vote without AI decisions
        const humanConfidence = 0.9;
        const adjustedConfidence = adjustConfidenceBasedOnPastGuesses(humanConfidence);
        
        newVote = {
          team,
          player: modelWithId, // Use uniquified model ID
          word,
          approved: true, // Humans vote to approve by default
          confidence: adjustedConfidence,
          timestamp: Date.now(),
          reason: "Human player voted",
          relatedClue: clueContent, // Store the current clue for traceability
          clueGuessCount: currentClueGuessCount, // Add count of guesses already made with this clue
          remainingScore: teamRemainingScore, // Add remaining score to win
          gameScore: { red: game.redScore || 0, blue: game.blueScore || 0 }, // Add current game score
          // CRITICAL FIX: Include pollId and messageId for proper association with UI polls
          pollId: req.body.pollId, // Keep the poll ID for UI matching
          messageId: req.body.messageId // Keep message ID for UI matching
        };
      } else {
        // For AI, get the decision
        const vote = await makeAgentDecision(
          model as AIModel,
          team,
          word,
          currentClue,
          game.teamDiscussion || [],
          availableWords,
          game.revealedCards || [],
          currentClueGuessCount
        );
        
        // Adjust confidence based on past guesses with this clue
        const adjustedConfidence = adjustConfidenceBasedOnPastGuesses(vote.confidence);
        
        newVote = {
          team,
          player: modelWithId, // Use uniquified model ID
          word,
          approved: vote.decision === "guess",
          confidence: adjustedConfidence,
          timestamp: Date.now(),
          reason: vote.explanation,
          relatedClue: clueContent, // Store the current clue for traceability
          clueGuessCount: currentClueGuessCount, // Add count of guesses already made with this clue
          remainingScore: teamRemainingScore, // Add remaining score to win
          gameScore: { red: game.redScore || 0, blue: game.blueScore || 0 }, // Add current game score
          // CRITICAL FIX: Include pollId and messageId for proper association with UI polls
          pollId: req.body.pollId, // Keep the poll ID for UI matching
          messageId: req.body.messageId // Keep message ID for UI matching
        };
      }

      // Add the vote to the consensus votes or update existing vote with max confidence
      let updatedVotes;
      if (existingVote) {
        // Take the max confidence between old and new vote
        const maxConfidence = Math.max(existingVote.confidence || 0, newVote.confidence || 0);
        
        // Create updated vote object with max confidence
        const updatedVote = {
          ...newVote,
          confidence: maxConfidence,
          // Store original timestamp to track the first time voted
          originalTimestamp: existingVote.originalTimestamp || existingVote.timestamp
        };
        
        // Replace existing vote
        updatedVotes = [...(game.consensusVotes || [])];
        updatedVotes[existingVoteIndex] = updatedVote;
        
        console.log(`📊 Updated vote confidence for ${model} on word ${word} to ${maxConfidence}`);
      } else {
        // Add as a new vote with originalTimestamp
        const voteWithOriginalTimestamp = {
          ...newVote,
          originalTimestamp: Date.now() // Track when first voted
        };
        updatedVotes = game.consensusVotes 
          ? [...game.consensusVotes, voteWithOriginalTimestamp]
          : [voteWithOriginalTimestamp];
      }

      await storage.updateGame(game.id, {
        consensusVotes: updatedVotes
      });

      // Calculate the voting status based on accurate team member count
      // Get all operatives (excluding spymaster) for accurate percentage calculation
      const teamOperatives = currentTeamPlayers.filter(
        (p: string) => p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      );
      
      const teamAIOperatives = teamOperatives.filter(
        (p: string) => p !== "human"
      ) as AIModel[];

      // CRITICAL FIX: Filter votes to only include those from this team for this word
      const teamVotes = updatedVotes.filter(v => v.team === team && v.word === word);
      const voteCount = teamVotes.length;
      
      // Use the operativesCount we calculated earlier to ensure consistency
      console.log(`Team ${team} has ${operativesCount} operatives for vote calculation`);
      
      // Make the threshold easier to reach by weighting human votes more
      const humanVoteCount = teamVotes.filter(v => 
        typeof v.player === 'string' && 
        (v.player === 'human' || v.player.startsWith('human#'))
      ).length;
      const aiVoteCount = voteCount - humanVoteCount;
      
      // Human votes count more than AI votes (weighting of 2)
      const weightedVoteCount = aiVoteCount + (humanVoteCount * 2);
      const totalVoters = Math.max(1, operativesCount);
      
      // Adjusted percentage calculation based on team size
      const votePercentage = Math.round((weightedVoteCount / totalVoters) * 100);
      
      // Ensure vote percentage is at least 30% if there's any vote at all
      const adjustedPercentage = voteCount > 0 ? Math.max(30, votePercentage) : 0;
      
      // Broadcast voting status to all clients
      const gameRoom = gameDiscussions.get(game.id);
      if (gameRoom) {
        console.log(`📊 Word votes status for "${word}": ${voteCount}/${totalVoters} (${adjustedPercentage}%)`);
        
        // Create a discussion message to show the vote in the chat
        const voterNames = teamVotes.map(v => v.player).join(', ');
        const discussionMessage = {
          team: team,
          player: 'Game',
          message: `Votes for "${word}": ${voterNames} (${adjustedPercentage}%)`,
          timestamp: Date.now()
        };
        
        // Add discussion message to game
        await storage.updateGame(game.id, {
          teamDiscussion: [
            ...(game.teamDiscussion || []),
            discussionMessage
          ]
        });
        
        // CRITICAL FIX: Filter clients by team membership to ensure each team only gets their own polls
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            // Get client connection info to check team
            const connInfo = connections.get(client);
            
            // Get the appropriate icon for each voter - ensuring max one icon per model
            // First deduplicate votes by model (keeping highest confidence vote per model)
            const modelVotes = new Map();
            teamVotes.forEach(v => {
              // Extract base model name without unique ID
              let baseModel = v.player;
              if (typeof baseModel === 'string') {
                if (baseModel.includes('#')) {
                  baseModel = baseModel.split('#')[0];
                } else if (baseModel.includes('-')) {
                  const parts = baseModel.split('-');
                  const validModels = ['gpt-4o', 'claude-3-5-sonnet-20241022', 'grok-2-1212', 'gemini-1.5-pro', 'llama-7b'];
                  if (validModels.includes(parts[0])) {
                    baseModel = parts[0];
                  }
                }
              }
              
              // If we already have a vote for this model, keep only the highest confidence one
              if (!modelVotes.has(baseModel) || v.confidence > modelVotes.get(baseModel).confidence) {
                modelVotes.set(baseModel, {
                  player: v.player,
                  baseModel,
                  confidence: v.confidence,
                  timestamp: v.timestamp
                });
              }
            });
            
            // Convert map back to array for display
            const voterIconInfo = Array.from(modelVotes.values()).map(v => {
              // Complete map of models to visual icons
              const iconMap: {[key: string]: string} = {
                // AI Models
                'gpt-4o': '🟢', // OpenAI - Green
                'claude-3-5-sonnet-20241022': '🟣', // Anthropic - Purple
                'grok-2-1212': '🔴', // Grok - Red
                'gemini-1.5-pro': '🔵', // Google - Blue
                'llama-7b': '🟡', // Meta - Yellow
                
                // Human users
                'human': '👤', // Human player
                
                // System
                'Game': '🎮'  // Game system messages
              };
              
              // Return player info with icon
              return { 
                player: v.player, 
                baseModel: v.baseModel,
                confidence: v.confidence,
                icon: iconMap[baseModel] || '🤖'
              };
            });
            
            // Format voter names with icons and add reasoning
            const formattedVoters = voterIconInfo.map(v => `${v.icon} ${typeof v.player === 'string' ? v.player.split('#')[0] : v.player}`).join(', ');
            
            // Add reasoning from votes to each voter
            const votersWithReasoning = voterIconInfo.map(voter => {
              // Find matching vote to get reasoning
              const matchingVote = teamVotes.find(v => 
                (typeof v.player === 'string' && typeof voter.player === 'string' && 
                 v.player.split('#')[0] === voter.player.split('#')[0])
              );
              
              return {
                ...voter,
                reasoning: matchingVote?.reason || null,
                clueGuessCount: matchingVote?.clueGuessCount || 0,
                gameScore: matchingVote?.gameScore || { red: game.redScore || 0, blue: game.blueScore || 0 }
              };
            });
            
            // Either send to all clients (for debugging) or filter by team 
            // Only send vote messages to clients on the same team
            if (!connInfo || connInfo.team === team) {
              // CRITICAL FIX: Ensure messageId and pollId are always both included and properly linked
              const messageIdToUse = req.body.messageId || `message-${team}-${word}-${Date.now()}`;
              const pollIdToUse = req.body.pollId || `word-${team}-${word}-${Date.now()}`;
              
              // Send vote message - include poll ID to ensure independent polls
              client.send(JSON.stringify({
                type: 'word_votes',
                team,
                // Include poll ID from request or generate a stable one for this vote instance
                pollId: pollIdToUse,
                words: [{
                  word,
                  votes: voteCount,
                  percentage: adjustedPercentage, // Use adjusted percentage
                  voters: votersWithReasoning,
                  clueGuessCount: currentClueGuessCount, 
                  gameScore: { red: game.redScore || 0, blue: game.blueScore || 0 }
                }],
                totalVoters,
                timestamp: Date.now(),
                messageId: messageIdToUse // Pass messageId for proper poll association
              }));
              
              // Also send a discussion message for this vote
              client.send(JSON.stringify({
                type: 'discussion',
                team: team,
                player: 'Game',
                content: `Votes for "${word}": ${formattedVoters} (${adjustedPercentage}%)`,
                message: `Votes for "${word}": ${formattedVoters} (${adjustedPercentage}%)`,
                timestamp: Date.now()
              }));
            }
          }
        });
      }

      // Check if all operatives have voted to ensure we wait for all votes
      const teamOperativesCount = operativesCount;
      const voteParticipation = voteCount / teamOperativesCount;
      const participationPercentage = Math.round(voteParticipation * 100);
      
      console.log(`🔍 Vote participation: ${voteCount}/${teamOperativesCount} operatives (${participationPercentage}%)`);
      
      // Three scenarios to determine if threshold is reached:
      // 1. All team operatives have voted (100% participation)
      const allOperativesVoted = voteCount >= teamOperativesCount;
      
      // 2. Lower threshold if it's a human vote on the current team's turn
      const hasHumanVote = teamVotes.some(v => 
        typeof v.player === 'string' && 
        (v.player === 'human' || v.player.startsWith('human#'))
      );
      const forceGuess = hasHumanVote && team === (game.currentTurn === 'red_turn' ? 'red' : 'blue');
      
      // 3. Multiple high confidence votes
      const highConfidenceVotes = teamVotes.filter(v => v.confidence >= 0.75);
      const hasHighConfidence = highConfidenceVotes.length >= 2; // Two or more high confidence votes
      
      // Determine if threshold is reached based on any scenario
      const thresholdReached = allOperativesVoted || 
                             (adjustedPercentage >= 50) || // Higher percentage with partial participation 
                             (voteParticipation >= 0.75 && adjustedPercentage >= 40); // Good participation with decent consensus
      
      console.log(`🔍 Enhanced vote threshold check: ${adjustedPercentage}% >= 30% or human vote: ${hasHumanVote} or high confidence: ${hasHighConfidence}`);
      
      // Create a meta poll regardless of whether the threshold was reached
      // This ensures users always see a poll after each vote
      if (team === (game.currentTurn === 'red_turn' ? 'red' : 'blue')) {
        // Create a unique pollId for the meta decision
        const metaDecisionPollId = `meta-${team}-${Date.now()}`;
        
        // Trigger meta poll for the team
        try {
          await fetch(`http://localhost:${process.env.PORT || 3000}/api/games/${gameId}/meta/discuss`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: "Should we guess this word or continue discussing?",
              team,
              triggerVoting: true,
              isVoting: true,
              voteType: 'meta_decision',
              forceMeta: true,
              pollId: metaDecisionPollId
            })
          });
          console.log(`📊 Created meta poll after vote with ID: ${metaDecisionPollId}`);
        } catch (metaError) {
          console.error("Error creating meta poll after vote:", metaError);
        }
      }
      
      if ((thresholdReached || forceGuess || hasHighConfidence) && team === (game.currentTurn === 'red_turn' ? 'red' : 'blue')) {
        console.log(`🎯 Consensus threshold reached for "${word}" with ${votePercentage}% of votes or ${highConfidenceVotes.length} high confidence votes. Processing guess.`);
        
        // If threshold is reached, process the guess
        // Add the word to revealed cards if not already there
        const updatedRevealedCards = game.revealedCards?.includes(word) 
          ? game.revealedCards 
          : [...(game.revealedCards || []), word];
        
        // Determine the result of the guess
        let result: "correct" | "wrong" | "assassin";
        if (word === game.assassin) {
          result = "assassin";
        } else if (
          (team === "red" && game.redTeam.includes(word)) ||
          (team === "blue" && game.blueTeam.includes(word))
        ) {
          result = "correct";
        } else {
          result = "wrong";
        }
        
        // Create the history entry
        const historyEntry = {
          type: "guess",
          turn: team,
          content: `${team.toUpperCase()} team guessed: ${word} (${result})`,
          timestamp: Date.now(),
          word: word,
          result: result,
          relatedClue: clueContent
        };
        
        // Calculate score updates
        let scoreUpdates: {redScore?: number, blueScore?: number} = {};
        
        // Award points to the team that OWNS the word
        if (game.redTeam.includes(word)) {
          scoreUpdates.redScore = (game.redScore || 0) + 1;
        } else if (game.blueTeam.includes(word)) {
          scoreUpdates.blueScore = (game.blueScore || 0) + 1;
        }
        
        // Handle turn changes based on guess result
        let turnUpdates = {};
        if (result === "assassin") {
          // If assassin, other team wins
          turnUpdates = {
            gameState: team === "red" ? "blue_win" : "red_win",
            currentTurn: game.currentTurn === "red_turn" ? "blue_turn" : "red_turn"
          };
        } else if (result === "wrong") {
          // If wrong guess, switch turns
          turnUpdates = {
            currentTurn: game.currentTurn === "red_turn" ? "blue_turn" : "red_turn"
          };
        } else if (result === "correct") {
          // CRITICAL FIX: Do not change turn for correct guesses (team's own word)
          // Just keep the current turn without adding turnUpdates
          console.log(`✅ ${team} team guessed their own word correctly - continuing their turn`);
          // No turnUpdates here - team keeps their turn
        }
        
        // Update game memory to track turn
        try {
          updateTurnResults(
            game.id, 
            team as "red" | "blue", 
            word, 
            result,
            clueContent ? { 
              word: clueContent.split(' ')[0], 
              number: parseInt(clueContent.match(/\((\d+)\)/)?.[1] || "0") 
            } : undefined
          );
        } catch (memError) {
          console.error("Error updating game memory:", memError);
        }
        
        // Update game with all changes
        await storage.updateGame(game.id, {
          revealedCards: updatedRevealedCards,
          gameHistory: [
            ...(game.gameHistory || []),
            historyEntry
          ],
          ...scoreUpdates,
          ...turnUpdates
        });
        
        // Broadcast guess to all clients
        if (gameRoom) {
          gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'guess',
                team,
                content: word,
                result,
                timestamp: Date.now()
              }));
            }
          });
        }
      }

      res.json({
        vote: newVote,
        voteCount,
        votePercentage,
        thresholdReached
      });
    } catch (error: any) {
      console.error("Error in AI vote:", error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Add a new endpoint for meta-voting (continue/end_turn decisions)
  // New endpoint specifically for meta decisions and discussions
  app.post("/api/games/:id/meta/discuss", async (req, res) => {
    try {
      const gameId = Number(req.params.id);
      const game = await storage.getGame(gameId);
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { message, team, triggerVoting, isVoting, voteType, forceMeta, pollId } = req.body;

      // Validate team
      if (!team || (team !== "red" && team !== "blue")) {
        return res.status(400).json({ error: "Valid team is required" });
      }

      const teamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      const aiTeammates = teamPlayers.filter(p => 
        p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      ) as AIModel[];

      // CRITICAL FIX: Use provided pollId if available, otherwise create a new unique one
      // Each meta decision should have a completely unique poll ID with specific timestamp
      // to prevent poll unification
      const metaDecisionPollId = pollId || `meta-${team}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      console.log(`🔑 Creating meta discussion with unique poll ID: ${metaDecisionPollId}`);

      // Create a system message to prompt discussion or meta decision
      const discussionEntry = {
        team,
        player: 'Game',
        message: message || "Team must decide: continue guessing or end turn?",
        timestamp: Date.now(),
        // Include voting flags if this is a meta decision request
        isVoting: isVoting === true || forceMeta === true || triggerVoting === true,
        voteType: voteType || 'meta_decision',
        // Include meta options if this is a meta decision
        metaOptions: ['continue', 'end_turn'],
        // Include the pollId to ensure all votes are tied to this specific decision
        pollId: metaDecisionPollId
      };

      console.log(`📝 Creating meta discussion: isVoting=${discussionEntry.isVoting}, voteType=${discussionEntry.voteType}`);

      // Add to game discussion log
      await storage.updateGame(gameId, {
        teamDiscussion: [...(game.teamDiscussion || []), discussionEntry]
      });

      // Broadcast to all clients - ensure all message properties are included
      const gameRoom = gameDiscussions.get(gameId);
      if (gameRoom) {
        console.log(`Broadcasting meta decision to ${gameRoom.clients.size} clients`);
        // CRITICAL FIX: Filter clients by team membership to ensure each team only gets their own polls
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            // Get client connection info to check team
            const connInfo = connections.get(client);
            
            // Only send meta discussion messages to clients on the same team
            if (!connInfo || connInfo.team === team) {
              client.send(JSON.stringify({
                type: 'discussion',
                team,
                player: 'Game',
                content: discussionEntry.message,
                message: discussionEntry.message, // Include for compatibility
                timestamp: discussionEntry.timestamp,
                isVoting: discussionEntry.isVoting,
                voteType: discussionEntry.voteType,
                metaOptions: discussionEntry.metaOptions,
                pollId: metaDecisionPollId // Pass the pollId to ensure client uses the same one
              }));
            }
          }
        });
      }

      // Trigger AI meta-votes if requested
      if ((triggerVoting || forceMeta)) {
        console.log(`🤖 Triggering meta votes for team ${team}`);
        
        // Each poll gets a UNIQUE POLL ID for complete independence
        // This is CRITICAL to solve the unified polls issue
        
        // Initialize the UI with empty polls first for better UX
        setTimeout(() => {
          // Generate a unique poll ID for the "continue" option
          const continuePollId = `meta-${team}-continue-${Date.now()}`;
          
          fetch(`http://localhost:${process.env.PORT || 3000}/api/games/${gameId}/meta/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'Game',
              team,
              action: 'continue', // Default system vote to continue
              confidence: 0.05, // Very low confidence - placeholder only
              pollId: continuePollId, // UNIQUE poll ID for the continue option
              messageId: metaDecisionPollId, // Associate with the meta decision message
              reasoning: "UI placeholder for team decision"
            })
          })
          .catch(err => console.error(`Error creating continue vote:`, err));
          
          // Create independent end_turn poll
          setTimeout(() => {
            const endTurnPollId = `meta-${team}-end_turn-${Date.now() + 1}`;
            
            // Add a placeholder end turn option with 0 votes
            fetch(`http://localhost:${process.env.PORT || 3000}/api/games/${gameId}/meta/vote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'Game',
                team,
                action: 'end_turn',
                confidence: 0.01, // Very low confidence
                pollId: endTurnPollId, // UNIQUE poll ID for the end_turn option
                messageId: metaDecisionPollId, // Associate with the meta decision message
                reasoning: "UI placeholder for team decision"
              })
            })
            .catch(err => console.error(`Error creating end_turn placeholder:`, err));
          }, 100);
        }, 200);
        
        // Only proceed with AI votes if we have AI teammates
        if (aiTeammates.length > 0) {
          console.log(`🤖 Triggering AI meta votes for ${aiTeammates.length} teammates`);
          
          // Then stagger AI votes for variety
          aiTeammates.forEach((model, index) => {
            setTimeout(async () => {
            // Use AI to make meta decisions instead of random choice
            // First create the appropriate prompt for meta decision
            const currentGame = await storage.getGame(gameId);
            const currentClue = currentGame?.gameHistory
              ?.filter(h => h.type === "clue" && h.turn === team)
              ?.pop()?.content || "";
            
            // Get remaining team words
            const teamWords = team === "red" ? currentGame?.redTeam : currentGame?.blueTeam;
            const remainingTeamWords = teamWords?.filter(word => 
              !currentGame?.revealedCards?.includes(word)
            ).length || 0;
            
            // Current score
            const teamScore = team === "red" ? currentGame?.redScore : currentGame?.blueScore;
            const opponentScore = team === "red" ? currentGame?.blueScore : currentGame?.redScore;
            
            // Recent guesses
            const guessesThisTurn = currentGame?.gameHistory?.filter(h => 
              h.type === "guess" && 
              h.turn === team && 
              h.result === "correct" &&
              h.timestamp > (currentGame.currentTurnStartTime?.getTime() || 0)
            ).length || 0;
            
            // Use the new dedicated meta decision function
            const { action, reasoning, confidence } = await getMetaDecision(
              model as AIModel,
              team as "red" | "blue",
              currentClue ? { 
                word: currentClue.split(' ')[0], 
                number: parseInt(currentClue.match(/\((\d+)\)/)?.[1] || "1") 
              } : { word: "", number: 1 },
              currentGame?.teamDiscussion || [],
              currentGame?.gameHistory || [],
              currentGame?.words || [],
              currentGame?.revealedCards || [],
              guessesThisTurn,
              { 
                red: currentGame?.redScore || 0, 
                blue: currentGame?.blueScore || 0 
              },
              gameId
            );
            
            // Generate a unique poll ID for this specific AI's vote on this specific action
            // This is CRITICAL for poll independence
            const uniqueAiPollId = `meta-${team}-${action}-${model}-${Date.now()}`;
            
            // Submit the AI's vote with a unique poll ID
            fetch(`http://localhost:${process.env.PORT || 3000}/api/games/${gameId}/meta/vote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                team,
                action,
                pollId: uniqueAiPollId, // UNIQUE poll ID for this specific vote
                messageId: metaDecisionPollId, // Associate with the meta decision message
                reasoning: reasoning || `AI model ${model} decided to ${action}`,
                confidence: confidence || 0.7
              })
            })
            .catch(err => console.error(`Error triggering meta vote for ${model}:`, err));
          }, index * 800 + 500);
        }); // End of aiTeammates forEach
        } // End of aiTeammates.length > 0 check
      }

      res.json({
        success: true,
        message: discussionEntry.message,
        isVoting: discussionEntry.isVoting,
        voteType: discussionEntry.voteType
      });
    } catch (error: any) {
      console.error("Error in meta discussion:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Enhance meta vote handling to maintain poll isolation
  app.post("/api/games/:id/meta/vote", async (req, res) => {
    try {
      const gameId = Number(req.params.id);
      const game = await storage.getGame(gameId);
      if (!game) return res.status(404).json({ error: "Game not found" });

      // Extract pollId from request - crucial for isolation
      const { model, team, action, pollId, uniqueId } = req.body;
      
      // Ensure pollId is required
      if (!pollId) {
        return res.status(400).json({ error: "pollId is required for vote isolation" });
      }
      
      // ENHANCED TEAM VALIDATION: Ensure the voter is on the correct team
      // Get team information 
      const isRedTeam = team === "red";
      const teamSpymaster = isRedTeam ? game.redSpymaster : game.blueSpymaster;
      const teamPlayers = isRedTeam ? game.redPlayers : game.bluePlayers;
      
      // CRITICAL SECURITY: Check if model is actually on this team
      // Parse model - might be "human" or "human#123456"
      let baseModel = model;
      if (typeof model === 'string' && model.includes('#')) {
        baseModel = model.split('#')[0];
      }
      
      // Check if this model/player is on the team they're trying to vote for
      const isTeamMember = teamPlayers?.includes(baseModel);
      if (!isTeamMember) {
        //console.log(`⛔ Blocking vote from ${model} - not a member of ${team} team`);
        return res.status(403).json({ 
          success: false, 
          message: `You cannot vote on ${team} team's decisions because you are not on that team`,
          wrongTeam: true
        });
      }
      
      // Check if this model is the team's spymaster - if so, skip the vote
      const isSpymaster = (model === teamSpymaster) || 
                        (typeof model === 'string' && model.startsWith(teamSpymaster));
      
      if (isSpymaster) {
        console.log(`⛔ Blocking vote from spymaster ${model} - spymasters are not allowed to vote`);
        return res.status(200).json({ 
          success: false, 
          message: "Spymasters cannot vote on team decisions",
          isSpymaster: true
        });
      }
      
      // Check if this model has already voted on this specific poll
      const existingVote = (game.metaVotes || []).find(v => 
        v.team === team && 
        v.pollId === pollId && 
        v.player === model
      );
      
      if (existingVote) {
        return res.status(200).json({ 
          success: true, 
          message: "Vote already recorded",
          pollId
        });
      }
      
      // CRITICAL FIX: Keep the existing poll ID to ensure votes belong to the same poll
      // Don't modify the poll ID or reuse it for different votes
      const uniqueMetaPollId = pollId;
      
      // CRITICAL FIX: Always keep messageId linked to pollId for proper UI association
      console.log(`📊 Processing meta vote: pollId=${pollId}, messageId=${req.body.messageId}, player=${model}`);
      
      // Create new vote with pollId and reasoning
      const newVote = {
        team,
        player: model,
        action,
        pollId: uniqueMetaPollId, // Use enhanced unique poll ID
        messageId: req.body.messageId || uniqueMetaPollId, // If messageId is missing, use pollId to ensure proper matching
        timestamp: Date.now(),
        reasoning: req.body.reasoning || "",
        confidence: req.body.confidence || 0.7,
        // Add to game log
        addToLog: true // Flag to show in game log
      };
      
      // CRITICAL FIX: Implement immediate end turn if this vote is to end the turn
      // This ensures meta voting for ending turn works correctly
      let shouldEndTurn = false;
      if (action === 'end_turn') {
        // Check how many votes there are for ending the turn
        const endTurnVotes = (game.metaVotes || [])
          .filter(v => v.team === team && v.action === 'end_turn')
          .length;
          
        // Include this new vote
        const totalEndTurnVotes = endTurnVotes + 1;
        
        // Get total number of operatives
        const teamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
        const teamOperatives = teamPlayers.filter(p => p !== teamSpymaster).length;
        
        // If more than 50% of operatives vote to end turn, we should end the turn
        shouldEndTurn = totalEndTurnVotes > teamOperatives / 2;
        console.log(`🔍 Meta decision check: ${totalEndTurnVotes}/${teamOperatives} votes to end turn - should end: ${shouldEndTurn}`);
      }
      
      // Update game state
      // First create the historyEntry before using it
      
      // Get the current clue and how many words guessed correctly so far
      const currentClue = game.gameHistory?.filter(h => h.type === "clue")?.pop();
      const correctGuessesForClue = game.gameHistory?.filter(h => 
        h.type === "guess" && 
        h.result === "correct" && 
        h.turn === team &&
        h.relatedClue === currentClue?.content
      ).length || 0;
      
      // Format the clue info for the history entry
      const clueInfo = currentClue ? `(Clue: ${currentClue.content}, Correct guesses: ${correctGuessesForClue})` : '';
      
      // Get player name for cleaner display
      const playerName = typeof model === 'string' ? model.split('#')[0] : model;
      
      // Ensure we have reasoning provided - use a default if none is available
      const reasoning = req.body.reasoning || 
        (action === 'continue' 
          ? `${playerName} thinks there are more words to find safely.` 
          : action === 'end_turn' 
            ? `${playerName} believes it's too risky to continue guessing.`
            : `${playerName} wants to discuss more before deciding.`);
      
      // Create a history entry with a clearer type field to ensure it's identified properly
      const historyEntry = {
        type: "meta_vote",
        turn: team,
        content: `Team Voting Decision: ${playerName} voted to ${action === 'continue' ? 'continue guessing' : action === 'end_turn' ? 'end the turn' : 'discuss more'}. ${clueInfo}`,
        timestamp: Date.now(),
        reasoning: reasoning, // Use validated reasoning
        voteAction: action,
        player: model,
        relatedClue: currentClue?.content,
        clueGuessCount: correctGuessesForClue,
        pollId: pollId, // Include the poll ID for deduplication
        // Add explicit flags for UI rendering - CRITICAL for showing reasoning in GameBoard
        hasReasoning: true, // Flag to ensure UI knows reasoning exists
        showReasoning: true, // Flag to encourage UI to show reasoning
        isMetaDecision: true, // Add additional flag to explicitly identify as meta decision
        // Add to gameHistory to ensure it appears in the game log
        addToGameLog: true
      };
      
      // Create a team discussion entry for the meta vote to ensure visibility
      const discussionEntry = {
        team: team,
        player: 'Game',
        message: `Team Voting Decision: ${playerName} voted to ${action === 'continue' ? 'continue guessing' : action === 'end_turn' ? 'end the turn' : 'discuss more'}.`,
        timestamp: Date.now(),
        isGameMessage: true,
        isMetaVote: true
      };
      
      let updates: any = {
        metaVotes: [...(game.metaVotes || []), newVote],
        gameHistory: [...(game.gameHistory || [])]
      };
      
      // Make sure we don't have duplicate entries
      const isDuplicateHistoryEntry = updates.gameHistory.some((entry: any) => 
        entry.type === "meta_vote" && 
        entry.player === model &&
        entry.voteAction === action &&
        entry.pollId === pollId
      );
      
      // Only add if not a duplicate
      if (!isDuplicateHistoryEntry) {
        // Add the history entry we created earlier
        updates.gameHistory.push(historyEntry);
        console.log(`✅ Meta vote will be added to game history`);
      } else {
        console.log(`⚠️ Skipping duplicate meta vote in game history`);
      }
      
      // If we should end the turn based on meta votes, make the change immediately
      if (shouldEndTurn && team === (game.currentTurn === "red_turn" ? "red" : "blue")) {
        console.log(`🔄 ENDING TURN BASED ON META VOTE MAJORITY`);
        
        // Change to opposite team's turn
        const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
        const nextTeam = game.currentTurn === "red_turn" ? "blue" : "red";
        const nextTurnState = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
        
        // Add these fields to the update
        updates.currentTurn = nextTurnState;
        updates.currentTurnStartTime = new Date(); // Reset timer for next team
        
        // Add a turn change message to game history
        const turnChangeHistoryEntry = {
          type: "turn_end",
          turn: currentTeam,
          content: `Team Voting Decision: ${currentTeam.toUpperCase()} team decided to end their turn.`,
          timestamp: Date.now() + 1, // Add 1ms to ensure it shows after the meta vote
          metaVoteResult: true
        };
        
        // Add the turn change entry to game history
        updates.gameHistory.push(turnChangeHistoryEntry);
        
        // Add turn change message to team discussion
        const turnChangeDiscussionEntry = {
          team: currentTeam,
          player: 'Game',
          message: `Team Voting Decision result: Turn ended. ${nextTeam.toUpperCase()} team's turn now.`,
          timestamp: Date.now() + 1,
          isGameMessage: true,
          isTurnChange: true
        };
        
        // Add to team discussion
        updates.teamDiscussion = [
          ...(game.teamDiscussion || []),
          discussionEntry,
          turnChangeDiscussionEntry
        ];
      } else {
        // Normal update without turn change - just add discussion entry
        updates.teamDiscussion = [
          ...(game.teamDiscussion || []),
          discussionEntry
        ];
      }
      
      // Apply all updates 
      await storage.updateGame(gameId, updates);
      
      // Log the entry we added to help with debugging
      console.log(`📝 Added meta vote to game history with reasoning: "${reasoning.substring(0, 50)}..."`);
      
      // We already updated the game state above, no need for a second update
      
      // Broadcast with pollId for client-side isolation and enhanced context
      const gameRoom = gameDiscussions.get(gameId);
      if (gameRoom) {
        // CRITICAL FIX: Make messageId and pollId consistent to ensure proper UI display
        // Use the exact same messageId that was saved in the vote object
        const messageIdToUse = newVote.messageId || uniqueMetaPollId;
        
        // Send message with explicitly including all fields
        const metaVoteMessage = {
          type: 'meta_vote',
          team: team,
          player: model,
          action: action,
          pollId: uniqueMetaPollId,
          timestamp: Date.now(),
          reasoning: newVote.reasoning,
          confidence: newVote.confidence,
          messageId: messageIdToUse, // Use the unified messageId for proper poll association
          // Include game context for better voting display
          gameContext: {
            currentClue: currentClue?.content,
            clueGuessCount: correctGuessesForClue,
            gameScore: { red: game.redScore || 0, blue: game.blueScore || 0 }
          },
          voters: [{ 
            player: model, 
            confidence: newVote.confidence || 0.7,
            reasoning: newVote.reasoning,
            // Add base model name for cleaner display
            baseModel: typeof model === 'string' && model.includes('#') ? model.split('#')[0] : model
          }]
        };
        
        console.log(`📣 Broadcasting meta vote with poll=${uniqueMetaPollId}, messageId=${messageIdToUse}`);
        
        
        // If we ended the turn, also broadcast a turn change message
        if (shouldEndTurn && team === (game.currentTurn === "red_turn" ? "red" : "blue")) {
          const currentTeam = game.currentTurn === "red_turn" ? "red" : "blue";
          const nextTeam = game.currentTurn === "red_turn" ? "blue" : "red";
          
          // Broadcast turn change to all clients
          const turnChangeMessage = {
            type: 'turn_change',
            from: currentTeam,
            to: nextTeam,
            reason: 'team_vote',
            timestamp: Date.now() + 1,
            forced: true
          };
          
          gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              // First send the meta vote
              client.send(JSON.stringify(metaVoteMessage));
              
              // Then send the turn change notification
              setTimeout(() => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(turnChangeMessage));
                }
              }, 100); // Small delay to ensure proper order
            }
          });
        } else {
          // Just send the meta vote message
          gameRoom.clients.forEach(client => {
            // Only send to clients in the same team
            const connInfo = connections.get(client);
            if (!connInfo || connInfo.team === team) {
              client.send(JSON.stringify(metaVoteMessage));
            }
          });
        }
      }
      
      res.json({ 
        success: true, 
        pollId: uniqueMetaPollId,
        action,
        reasoning: newVote.reasoning,
        player: model 
      });
    } catch (error) {
      console.error("Error processing meta vote:", error);
      res.status(500).json({ error: "Failed to process vote" });
    }
  });

  app.get("/api/games/:id", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      // Determine the current team based on game state
      const currentTeam = game.currentTurn?.startsWith('red') ? 'red' : 'blue';
      const currentSpymaster = currentTeam === 'red' ? game.redSpymaster : game.blueSpymaster;
      
      // Track if we've modified the game state
      let gameModified = false;

      // Check if we need to trigger team discussion first
      if (game.pendingTeamDiscussion === true) {
        // Clear the pending discussion flag
        await storage.updateGame(game.id, {
          pendingTeamDiscussion: false
        });
        
        // Force team discussion phase through WebSocket
        const gameRoom = gameDiscussions.get(game.id);
        if (gameRoom) {
          gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'discussion',
                team: currentTeam,
                player: 'Game',
                message: `${currentTeam.toUpperCase()} team, discuss your strategy...`,
                timestamp: Date.now()
              }));
            }
          });
        }
        
        gameModified = true;
      }
      // Check if this is a new turn with no clue given yet
      else if (!game.pendingTeamDiscussion && !game.currentClue && game.gameState === 'playing') {
        // Check if there's a recent spymaster clue in the game history or team discussion
        const hasRecentClue = game.gameHistory?.some(entry => 
          entry.type === 'clue' && 
          entry.turn === currentTeam && 
          entry.timestamp > Date.now() - 30000
        );
        
        if (!hasRecentClue) {
          console.log(`🔍 No recent clue found for ${currentTeam} team, triggering spymaster`);
          
          // Trigger the spymaster to give a clue
          try {
            const clue = await getSpymasterClue(
              game.id,
              currentTeam as "red" | "blue",
              currentSpymaster as AIModel,
              game
            );
            
            // Mark that a change was made
            gameModified = true;
            
            console.log(`🔍 Spymaster ${currentSpymaster} gave clue: ${clue.word} (${clue.number})`);
          } catch (error) {
            console.error("Error getting spymaster clue:", error);
          }
        }
      }
      
      // If we modified the game, get the updated version
      if (gameModified) {
        const updatedGame = await storage.getGame(Number(req.params.id));
        return res.json(updatedGame || game);
      }
      
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