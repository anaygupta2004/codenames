import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { 
  getSpymasterClue, 
  getGuesserMove, 
  discussAndVote, 
  makeAgentDecision,
  formatDiscussionMessage,
  updateTeamMemory 
} from "./lib/ai-service";
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
    revealedCards: newRevealedCards,
    // IMPORTANT: Reset turn timer whenever a guess is made
    currentTurnStartTime: new Date()
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
  const gameRoom = gameDiscussions.get(gameId);
  if (!gameRoom || gameRoom.aiDiscussionInProgress) {
    console.log('❌ Discussion blocked - gameRoom missing or discussion in progress');
    return;
  }

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

      // Make sure we have revealed cards info
      const revealedCards = game.revealedCards || [];

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
        revealedCards
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
          handleAIDiscussion(game.id, aiPlayers, clue, team, true);
        }
      }

      const historyEntry: GameHistoryEntry = {
        type: "clue",
        turn: isRedTurn ? "red" : "blue",
        content: `${clue.word} (${clue.number})`,
        timestamp: Date.now()
      };

      // Update the game state with the clue and reset the turn timer
      await storage.updateGame(game.id, {
        gameHistory: game.gameHistory ? [...game.gameHistory, historyEntry] : [historyEntry],
        // CRITICAL: Reset turn timer when a clue is given
        currentTurnStartTime: new Date()
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
          if (
            (game.currentTurn === "red_turn" && !game.redTeam.includes(newCard)) ||
            (game.currentTurn === "blue_turn" && !game.blueTeam.includes(newCard))
          ) {
          result = "wrong";
            updates.currentTurn = game.currentTurn === "red_turn" ? "blue_turn" : "red_turn";
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
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, word } = req.body;

      if (!team) {
        return res.status(400).json({ error: "Team is required" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      
      // Allow human votes without model validation
      if (model !== 'human' && (!model || !VALID_MODELS.includes(model as AIModel))) {
        return res.status(400).json({ error: "Invalid model" });
      }

      if (model !== 'human' && !currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      const clueContent = game.gameHistory?.filter(h => h.type === "clue")?.pop()?.content || "";
      const clueMatch = clueContent.match(/^(.+?)\s*\((\d+)\)$/);
      const currentClue = clueMatch 
        ? { word: clueMatch[1], number: parseInt(clueMatch[2]) }
        : { word: "unknown", number: 1 };

      const availableWords = game.words.filter(w => !(game.revealedCards || []).includes(w));
      
      // Create the new vote object
      let newVote: ConsensusVote;
      
      if (model === 'human') {
        // For human votes, create a direct vote without AI decisions
        newVote = {
        team,
          player: model,
        word,
          approved: true, // Humans vote to approve by default
          confidence: 0.9,
          timestamp: Date.now(),
          reason: "Human player voted",
          relatedClue: clueContent // Store the current clue for traceability
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
          (game.teamDiscussion || []).filter(d => 
            d.team === team && 
            d.suggestedWord && 
            game.gameHistory?.some(h => 
              h.type === "guess" && 
              h.turn === team && 
              h.word === d.suggestedWord
            )
          ).length
        );
        
        newVote = {
        team,
        player: model,
        word,
          approved: vote.decision === "guess",
          confidence: vote.confidence,
          timestamp: Date.now(),
          reason: vote.explanation,
          relatedClue: clueContent // Store the current clue for traceability
        };
      }

      // Add the vote to the consensus votes
      const updatedVotes = game.consensusVotes 
        ? [...game.consensusVotes, newVote]
        : [newVote];

      await storage.updateGame(game.id, {
        consensusVotes: updatedVotes
      });

      // Calculate the voting status
      const teamAIPlayers = currentTeamPlayers.filter(
        (p: string) => p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      ) as AIModel[];

      const teamVotes = updatedVotes.filter(v => v.team === team && v.word === word);
      const voteCount = teamVotes.length;
      
      // Get actual team member count (excluding spymaster)
      const effectiveTeamSize = currentTeamPlayers.filter(p => 
        p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      ).length;
      
      // Make the threshold easier to reach by weighting human votes more
      const humanVoteCount = teamVotes.filter(v => v.player === 'human').length;
      const aiVoteCount = voteCount - humanVoteCount;
      
      // Human votes count more than AI votes (weighting of 2)
      const weightedVoteCount = aiVoteCount + (humanVoteCount * 2);
      const totalVoters = Math.max(1, effectiveTeamSize);
      
      // Adjusted percentage calculation
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
        
        // Send messages to all clients
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            // Send vote message
            client.send(JSON.stringify({
              type: 'word_votes',
              team,
              words: [{
                word,
                votes: voteCount,
                percentage: adjustedPercentage, // Use adjusted percentage
                voters: teamVotes.map(v => ({ player: v.player, confidence: v.confidence }))
              }],
              totalVoters,
              timestamp: Date.now()
            }));
            
            // Also send a discussion message for this vote
            client.send(JSON.stringify({
              type: 'discussion',
              team: team,
              player: 'Game',
              content: `Votes for "${word}": ${voterNames} (${adjustedPercentage}%)`,
              message: `Votes for "${word}": ${voterNames} (${adjustedPercentage}%)`,
              timestamp: Date.now()
            }));
          }
        });
      }

      // ENHANCED AUTOMATIC VOTING: Lower threshold to make guessing more aggressive
      // For automated guessing, we want to be more aggressive with threshold
      const thresholdReached = adjustedPercentage >= 30; // Lower threshold to 30%
      
      // If it's a human vote, always consider it enough to make a guess
      const hasHumanVote = teamVotes.some(v => v.player === 'human');
      const forceGuess = hasHumanVote && team === (game.currentTurn === 'red_turn' ? 'red' : 'blue');
      
      // Also allow automatic guessing based on confidence values
      const highConfidenceVotes = teamVotes.filter(v => v.confidence >= 0.75);
      const hasHighConfidence = highConfidenceVotes.length >= 2; // Two or more high confidence votes
      
      console.log(`🔍 Enhanced vote threshold check: ${adjustedPercentage}% >= 30% or human vote: ${hasHumanVote} or high confidence: ${hasHighConfidence}`);
      
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
        } else if (
          // Check if guessing team's own word (correct) but it's a neutral word or opponent's word
          (team === "red" && !game.redTeam.includes(word)) ||
          (team === "blue" && !game.blueTeam.includes(word))
        ) {
          // Still switch turn if it's the wrong team's word
          turnUpdates = {
            currentTurn: game.currentTurn === "red_turn" ? "blue_turn" : "red_turn"
          };
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
  app.post("/api/games/:id/meta/vote", async (req, res) => {
    try {
      const game = await storage.getGame(Number(req.params.id));
      if (!game) return res.status(404).json({ error: "Game not found" });

      const { model, team, action } = req.body;

      if (!team) {
        return res.status(400).json({ error: "Team is required" });
      }
      
      if (!action || !["continue", "end_turn", "discuss_more"].includes(action)) {
        return res.status(400).json({ error: "Invalid action" });
      }

      // Allow human votes without model validation
      if (model !== 'human' && (!model || !VALID_MODELS.includes(model as AIModel))) {
        return res.status(400).json({ error: "Invalid model" });
      }

      const currentTeamPlayers = team === "red" ? game.redPlayers : game.bluePlayers;
      if (model !== 'human' && !currentTeamPlayers.includes(model)) {
        return res.status(400).json({ error: "AI model is not part of the team" });
      }

      // Create a new meta vote entry
      const newVote = {
        team,
        player: model,
        action,
        timestamp: Date.now(),
        confidence: 0.8
      };

      // Store meta votes (you might need to add a new field to the game schema)
      const metaVotes = game.metaVotes || [];
      const updatedMetaVotes = [...metaVotes, newVote];
      
      await storage.updateGame(game.id, {
        metaVotes: updatedMetaVotes
      });

      // Calculate voting metrics
      const teamAIPlayers = currentTeamPlayers.filter(
        (p: string) => p !== "human" && p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      );
      
      const actionVotes = updatedMetaVotes.filter(v => v.team === team && v.action === action);
      const voteCount = actionVotes.length;
      
      // Get actual team size (excluding spymaster)
      const effectiveTeamSize = currentTeamPlayers.filter(p => 
        p !== (team === "red" ? game.redSpymaster : game.blueSpymaster)
      ).length;
      
      // Make the threshold easier to reach by weighting human votes more
      const humanVoteCount = actionVotes.filter(v => v.player === 'human').length;
      const aiVoteCount = voteCount - humanVoteCount;
      
      // Human votes count more than AI votes (weighting of 2)
      const weightedVoteCount = aiVoteCount + (humanVoteCount * 2);
      const totalVoters = Math.max(1, effectiveTeamSize);
      
      // Adjusted percentage calculation
      const votePercentage = Math.round((weightedVoteCount / totalVoters) * 100);
      
      // Ensure at least 30% if there's any vote
      const adjustedPercentage = voteCount > 0 ? Math.max(30, votePercentage) : 0;
      
      // Create a discussion message to show the vote in the chat
      const voterNames = actionVotes.map(v => v.player).join(', ');
      const discussionMessage = {
        team,
        player: 'Game',
        message: `Meta vote for "${action}": ${voterNames} (${adjustedPercentage}%)`,
        timestamp: Date.now()
      };
      
      // Add discussion message to game
      await storage.updateGame(game.id, {
        teamDiscussion: [
          ...(game.teamDiscussion || []),
          discussionMessage
        ]
      });
      
      // Broadcast meta vote status to all clients
      const gameRoom = gameDiscussions.get(game.id);
      if (gameRoom) {
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            // Send meta vote data
            client.send(JSON.stringify({
              type: 'meta_vote',
              action,
              votes: voteCount,
              totalVoters,
              percentage: adjustedPercentage, // Use adjusted percentage
              voters: actionVotes.map(v => ({ player: v.player, confidence: v.confidence || 0.8 })),
              team,
              timestamp: Date.now()
            }));
            
            // Also send discussion message for the vote
            client.send(JSON.stringify({
              type: 'discussion',
              team,
              player: 'Game',
              content: `Meta vote for "${action}": ${voterNames} (${adjustedPercentage}%)`,
              message: `Meta vote for "${action}": ${voterNames} (${adjustedPercentage}%)`,
              timestamp: Date.now()
            }));
          }
        });
      }

      // ENHANCED META VOTING: Make timer expiration cause a turn change every time
      const hasHumanVote = actionVotes.some(v => v.player === 'human');
      const timerExpired = req.body.timerExpired === true;
      const thresholdReached = adjustedPercentage >= 30; // Lower to 30% for quicker decisions
      const hasGameVote = actionVotes.some(v => v.player === 'Game'); // System-initiated vote
      
      // Force action if: human voted, timer expired, or game system voted
      const forceAction = hasHumanVote || hasGameVote || timerExpired;
      
      // Also allow high confidence meta votes
      const highConfidenceVotes = actionVotes.filter(v => v.confidence >= 0.8);
      const hasHighConfidence = highConfidenceVotes.length >= Math.max(1, Math.floor(totalVoters / 3));
      
      let shouldEndTurn = false;
      let shouldContinue = false;
      
      // CRITICAL: If timer expired, always end the turn no matter what
      if (timerExpired) {
        console.log(`⏰ TIMER EXPIRED - Automatically ending ${team} team's turn`);
        shouldEndTurn = true;
      } else if (thresholdReached || forceAction || hasHighConfidence) {
        console.log(`🎮 Meta action "${action}" will be executed (${adjustedPercentage}% or automatic vote) with ${actionVotes.length} votes`);
        if (action === 'end_turn') {
          shouldEndTurn = true;
        } else if (action === 'continue') {
          shouldContinue = true;
        }
      }
      
      // Handle end turn action if consensus reached or timer expired
      if (shouldEndTurn) {
        const nextTurn = team === 'red' ? "blue_turn" : "red_turn";
        
        // CRITICAL: Create all updates in a single transaction to prevent race conditions
        const updates = {
          currentTurn: nextTurn,
          // Reset turn timer by updating current turn start time
          currentTurnStartTime: new Date(),
          // Add turn end to game history with reason
          gameHistory: [
            ...(game.gameHistory || []),
            {
              type: "turn_end",
              turn: team,
              content: timerExpired ? 
                `${team.toUpperCase()} team's turn ended due to time expiration` :
                `${team.toUpperCase()} team ended their turn by voting`,
              timestamp: Date.now(),
              // Add explicit forced flag for mandatory turn changes
              forced: timerExpired
            }
          ]
        };
        
        // Apply all updates in a single database call
        await storage.updateGame(game.id, updates);
        
        // Log the turn change for debugging
        console.log(`🔄 TURN CHANGED ${team} → ${team === 'red' ? 'blue' : 'red'}, reason: ${timerExpired ? 'timer_expired' : 'vote'}`);
        
        // Broadcast the turn change to all clients with a high-priority flag
        if (gameRoom) {
          const turnChangeMsg = {
            type: 'turn_change',
            from: team,
            to: team === 'red' ? 'blue' : 'red',
            reason: timerExpired ? 'time_expired' : 'vote',
            timestamp: Date.now(),
            // Add high-priority flag for timer expiration
            highPriority: timerExpired,
            forced: timerExpired
          };
          
          // Convert to string once for efficiency
          const msgStr = JSON.stringify(turnChangeMsg);
          
          // Send to all clients
          gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(msgStr);
            }
          });
          
          // For timer expiration, send a duplicate notification to ensure it's processed
          if (timerExpired) {
            setTimeout(() => {
              // Include a slightly modified timestamp to ensure it's processed as a new message
              const followupMsg = {
                ...turnChangeMsg,
                timestamp: Date.now() + 1,
                followup: true
              };
              
              gameRoom.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(followupMsg));
                }
              });
            }, 500); // Send follow-up after short delay
          }
        }
      }

      res.json({
        vote: newVote,
        voteCount,
        totalVoters,
        percentage: votePercentage,
        action: shouldEndTurn ? 'turn_ended' : shouldContinue ? 'continuing' : 'vote_recorded'
      });
    } catch (error: any) {
      console.error("Error in meta vote:", error);
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