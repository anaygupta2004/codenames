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
  let updates: any = { revealedCards: newRevealedCards };
  
  if (word === game.assassin) {
    result = "assassin";
    updates.gameState = team === "red" ? "blue_win" : "red_win";
  } else if (
    (team === "red" && game.redTeam.includes(word)) ||
    (team === "blue" && game.blueTeam.includes(word))
  ) {
    result = "correct";
    if (game.redTeam.includes(word)) {
      updates.redScore = (game.redScore || 0) + 1;
    } else if (game.blueTeam.includes(word)) {
      updates.blueScore = (game.blueScore || 0) + 1;
    }
  } else {
    result = "wrong";
    updates.currentTurn = team === "red" ? "blue_turn" : "red_turn";
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
  
  // Broadcast the guess to all clients
  const gameRoom = gameDiscussions.get(gameId);
  if (gameRoom) {
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

async function handleAIDiscussion(
  gameId: number, 
  team: string, 
  clue: { word: string; number: number },
  aiPlayers: AIModel[]
) {
  console.log(`🎮 Starting AI discussion for game ${gameId}, team ${team}, clue: ${clue.word}`);
  const gameRoom = gameDiscussions.get(gameId);
  console.log('Current game room state:', {
    hasRoom: !!gameRoom,
    inProgress: gameRoom?.aiDiscussionInProgress,
    teamModels: gameRoom?.teamModels
  });

  if (!gameRoom || gameRoom.aiDiscussionInProgress) {
    console.log('❌ Discussion blocked - gameRoom missing or discussion in progress');
    return;
  }

  gameRoom.aiDiscussionInProgress = true;
  let guessCount = 0;
  const maxGuesses = clue.number + 1; // maximum allowed guesses (can be raised if desired)
  let continueGuessing = true; // flag to continue discussion
  let discussionRound = 1; // track discussion rounds
  let votingTriggered = false; // track if voting has been triggered yet
  
  try {
    while (continueGuessing) {
      const game = await storage.getGame(gameId);
      console.log(`🔄 Game discussion state (round ${discussionRound}):`, {
        discussionCount: game?.teamDiscussion?.length,
        lastMessages: game?.teamDiscussion?.slice(-3),
        votingTriggered
      });

      // Retrieve the current game state
      if (!game) break;
  
      // Run discussions in parallel via each AI agent (spymaster messages as well as regular discussion)
      const discussionPromises = aiPlayers.map(async (aiPlayer) => {
        console.log(`Getting discussion from ${aiPlayer}`);
        
        // Get team information
        const isRedTeam = team === "red";
        const teamScore = isRedTeam ? game.redScore : game.blueScore;
        const opposingScore = isRedTeam ? game.blueScore : game.redScore;
        
        // Calculate current round for this agent
        const currentRound = (game.teamDiscussion || [])
          .filter(d => d.team === team && d.player === aiPlayer)
          .length + 1;
          
        // Track guesses made for current clue with results
        const currentClueGuesses = (game.gameHistory || [])
          .filter(h => 
            h.type === "guess" && 
            h.turn === team && 
            h.relatedClue === clue.word
          );
            
        // Get successful and unsuccessful guesses
        const successfulGuesses = currentClueGuesses
          .filter(g => g.result === "correct")
          .map(g => g.word);
            
        const unsuccessfulGuesses = currentClueGuesses
          .filter(g => g.result !== "correct" && g.result !== undefined)
          .map(g => g.word);
        
        console.log(`Team ${team} clue "${clue.word}": correct guesses: ${successfulGuesses.join(", ")}, wrong guesses: ${unsuccessfulGuesses.join(", ")}`);
        
        // Count for input parameter
        const clueGuesses = currentClueGuesses.length;
        
        const discussion = await discussAndVote(
          aiPlayer,
          team as "red" | "blue",
          game.words,
          clue,
          game.teamDiscussion || [],
          game.gameHistory || [],
          game.revealedCards || [],
          currentRound,
          "team member",
          teamScore,
          opposingScore,
          new Date(),
          60, // turn time limit
          clueGuesses,
          game.id
        );
        console.log(`${aiPlayer} discussion result:`, discussion);
        return { player: aiPlayer, discussion };
      });
      const discussions = await Promise.all(discussionPromises);
  
      // For each AI agent, broadcast its discussion message so the team discussion chat is updated
      // Check if we've reached a point where voting should be triggered
      // We want to transition after all agents have had a chance to speak
      const hasEveryoneSpokeThisRound = aiPlayers.every(player => {
        const messagesInRound = (game.teamDiscussion || []).filter(d => 
          d.team === team && 
          d.player === player &&
          d.round === discussionRound
        );
        return messagesInRound.length > 0;
      });
      
      // Decide if we should trigger voting in this round - trigger immediately after all agents speak once
      if (hasEveryoneSpokeThisRound && !votingTriggered) {
        votingTriggered = true;
        console.log(`🗳️ All agents have spoken in round ${discussionRound} - triggering voting phase`);
        
        // NEW: Collect all suggested words from all agents with their confidences
        const allSuggestions = discussions.flatMap(({ player, discussion }) => {
          const suggestedWords = Array.isArray(discussion.suggestedWords) && discussion.suggestedWords.length > 0
            ? discussion.suggestedWords
            : discussion.suggestedWord ? [discussion.suggestedWord] : [];
          
          const confidences = Array.isArray(discussion.confidences) && discussion.confidences.length > 0
            ? discussion.confidences
            : Array(suggestedWords.length).fill(discussion.confidence || 0.5);
          
          return suggestedWords.map((word, idx) => ({
            word,
            confidence: confidences[idx] || discussion.confidence || 0.5,
            player
          }));
        });
        
        console.log(`🔍 All agent suggestions collected: ${allSuggestions.length} suggestions`);
        
        // Group suggestions by word with aggregate confidence
        const wordConfidences = allSuggestions.reduce((acc, { word, confidence, player }) => {
          if (!acc[word]) {
            acc[word] = { totalConfidence: 0, supporters: new Set(), voters: [] };
          }
          acc[word].totalConfidence += confidence;
          acc[word].supporters.add(player);
          acc[word].voters.push({ player, confidence });
          return acc;
        }, {} as Record<string, { totalConfidence: number, supporters: Set<string>, voters: any[] }>);
        
        // Find the word with highest confidence across all agents
        const sortedWords = Object.entries(wordConfidences)
          .sort(([_, a], [__, b]) => b.totalConfidence - a.totalConfidence)
          .map(([word, data]) => ({
            word,
            totalConfidence: data.totalConfidence,
            supporterCount: data.supporters.size,
            voters: data.voters
          }));
        
        if (sortedWords.length > 0) {
          const bestWord = sortedWords[0];
          console.log(`🥇 Best word suggestion: "${bestWord.word}" with ${bestWord.totalConfidence.toFixed(2)} confidence`);
          
          // Calculate voting metrics for UI display
          const teamAICount = team === 'red'
            ? game.redPlayers.filter(p => p !== 'human' && p !== game.redSpymaster).length
            : game.bluePlayers.filter(p => p !== 'human' && p !== game.blueSpymaster).length;
          
          const votePercentage = Math.round((bestWord.supporterCount / Math.max(1, teamAICount)) * 100);
          
          // Broadcast vote status to all clients
          gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'word_votes',
                team,
                words: [{
                  word: bestWord.word,
                  votes: bestWord.supporterCount,
                  percentage: votePercentage,
                  voters: bestWord.voters
                }],
                totalVoters: teamAICount,
                timestamp: Date.now()
              }));
            }
          });
          
          // Process the guess automatically for the best word
          if (!game.revealedCards?.includes(bestWord.word)) {
            // Prepare and process guess
            const guessMessage = {
              type: 'guess',
              content: bestWord.word,
              team,
              timestamp: Date.now()
            };
            
            // Broadcast the guess
            gameRoom.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(guessMessage));
              }
            });
            
            // Update game state with the guess
            const updatedGame = await storage.getGame(gameId);
            if (updatedGame) {
              const newRevealedCards = [...(updatedGame.revealedCards || []), bestWord.word];
              
              // Determine the result of the guess
              let result: "correct" | "wrong" | "assassin";
              if (bestWord.word === updatedGame.assassin) {
                result = "assassin";
              } else if (
                (team === "red" && updatedGame.redTeam.includes(bestWord.word)) ||
                (team === "blue" && updatedGame.blueTeam.includes(bestWord.word))
              ) {
                result = "correct";
              } else {
                result = "wrong";
              }
              
              // Create the history entry
              const historyEntry = {
                type: "guess",
                turn: team,
                content: `${team.toUpperCase()} team guessed: ${bestWord.word} (${result})`,
                timestamp: Date.now(),
                word: bestWord.word,
                result: result,
                relatedClue: updatedGame.gameHistory?.filter(h => h.type === "clue")?.pop()?.content || ""
              };
              
              // Calculate score updates
              let updates: any = {
                revealedCards: newRevealedCards,
                gameHistory: [
                  ...(updatedGame.gameHistory || []),
                  historyEntry
                ]
              };
              
              if (updatedGame.redTeam.includes(bestWord.word)) {
                updates.redScore = (updatedGame.redScore || 0) + 1;
              } else if (updatedGame.blueTeam.includes(bestWord.word)) {
                updates.blueScore = (updatedGame.blueScore || 0) + 1;
              }
              
              if (result === "assassin") {
                updates.gameState = team === "red" ? "blue_win" : "red_win";
              } else if (result === "wrong") {
                updates.currentTurn = team === "red" ? "blue_turn" : "red_turn";
              }
              
              // Update game state with all changes
              await storage.updateGame(gameId, updates);
              
              // Send an AI feedback message about the guess result to the discussion
              const resultMessage = {
                team: team as "red" | "blue",
                player: "Game" as const,
                message: `Team ${team} guessed "${bestWord.word}" - ${result === "correct" ? "CORRECT! ✅" : result === "wrong" ? "WRONG! ❌" : "ASSASSIN! ☠️"}`,
                confidences: [1],
                suggestedWords: [],
                timestamp: Date.now(),
                round: discussionRound,
                isVoting: true,
                voteType: result === "correct" ? "continue" : "end_turn"
              };
              
              // Add result message to discussion
              await storage.updateGame(gameId, {
                teamDiscussion: [
                  ...(updatedGame.teamDiscussion || []),
                  resultMessage
                ]
              });
              
              // Send result message to clients
              gameRoom.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'discussion',
                    ...resultMessage
                  }));
                }
              });
              
              // If the guess was wrong or assassin, end team's turn
              if (result !== "correct") {
                continueGuessing = false;
                break;
              }
              
              // Update guess count
              guessCount++;
              
              // Reset for next round of suggestions if the guess was correct
              votingTriggered = false;
              discussionRound++;
            }
          }
        }
      }

      const newDiscussionMessages = discussions.map(({ player, discussion }) => {
        // Ensure consistent arrays for suggestedWords and confidences
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

        // Only enable voting when explicitly triggered
        // We want ALL agents to make suggestions first before enabling voting
        const shouldEnableVoting = votingTriggered;

        console.log(`🔶 AI Discussion from ${player}:`, {
          hasWords: suggestedWordsArray.length > 0,
          words: suggestedWordsArray,
          confidences: confidencesArray,
          action: discussion.action,
          isVoting: shouldEnableVoting
        });
          
        return {
          team: team as "red" | "blue",
          player,
          message: formatDiscussionMessage(
            player, 
            discussion.message, 
            confidencesArray[0] || 0.8, 
            null, // No longer using suggestedWord
            suggestedWordsArray
          ),
          confidences: confidencesArray,
          suggestedWords: suggestedWordsArray,
          risk: discussion.risk || "Medium",
          round: discussionRound,
          timestamp: Date.now(),
          // Mark as voting message if we've reached the voting phase, agent wants to vote, or has suggestions
          isVoting: shouldEnableVoting,
          // Set vote type based on action or default to continue
          voteType: discussion.action === "end_turn" ? "end_turn" : "continue"
        };
      });

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
  
      // Check for agents wanting to end turn
      const endTurnSuggestions = discussions
        .filter(({ discussion }) => discussion.action === "end_turn" && discussion.confidence > 0.7)
        .map(({ player, discussion }) => ({
          player,
          confidence: discussion.confidence,
          reasoning: discussion.reasoning || "No specific reason provided"
        }));
      
      // Broadcast voting status for end turn decision
      if (endTurnSuggestions.length > 0) {
        // Count total active team members
        const teamAICount = team === 'red'
          ? game.redPlayers.filter(p => p !== 'human' && p !== game.redSpymaster).length
          : game.bluePlayers.filter(p => p !== 'human' && p !== game.blueSpymaster).length;
        
        // Calculate voting percentages
        const votePercentage = Math.round((endTurnSuggestions.length / Math.max(1, teamAICount)) * 100);
        
        // Broadcast voting status
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'meta_vote',
              action: 'end_turn',
              votes: endTurnSuggestions.length,
              totalVoters: teamAICount,
              percentage: votePercentage,
              voters: endTurnSuggestions.map(s => ({ player: s.player, confidence: s.confidence })),
              team,
              timestamp: Date.now()
            }));
          }
        });
      }
      
      // Make it easier to end turn - lower the threshold for endTurn suggestions
      if (endTurnSuggestions.length >= 1 || votingTriggered) {
        // Calculate end turn vote percentage
        const teamAICount = team === 'red'
          ? game.redPlayers.filter(p => p !== 'human' && p !== game.redSpymaster).length
          : game.bluePlayers.filter(p => p !== 'human' && p !== game.blueSpymaster).length;
        
        const votePercentage = Math.round((endTurnSuggestions.length / Math.max(1, teamAICount)) * 100);
        
        // End turn if at least one agent suggests it with high confidence,
        // or if multiple agents suggest it, or if we're in voting mode
        const shouldEndTurn = endTurnSuggestions.length >= 2 || 
          (endTurnSuggestions.length === 1 && endTurnSuggestions[0].confidence > 0.7) ||
          (votePercentage > 40);
        
        // Broadcast the end turn voting status
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'meta_vote',
              action: 'end_turn',
              votes: endTurnSuggestions.length,
              totalVoters: teamAICount,
              percentage: votePercentage,
              voters: endTurnSuggestions.map(s => ({ player: s.player, confidence: s.confidence })),
              team,
              timestamp: Date.now()
            }));
          }
        });
        
        if (shouldEndTurn) {
          console.log(`Team ${team} decided to end turn: ${endTurnSuggestions.length} agents suggested it (${votePercentage}%)`);
          
          // Create an end turn history entry
          const reasonings = endTurnSuggestions.map(s => `${s.player}: ${s.reasoning}`).join("; ");
          const historyEntry: GameHistoryEntry = {
            type: "end_turn",
            turn: team as "red" | "blue",
            content: `${team.toUpperCase()} team decided to end their turn. Reason: ${reasonings}`,
            timestamp: Date.now(),
            word: '', // No word for end turn
            relatedClue: clue.word
          };
          
          await storage.updateGame(gameId, {
            gameHistory: [
              ...(game.gameHistory || []),
              historyEntry
            ],
            currentTurn: team === 'red' ? "blue_turn" : "red_turn"
          });
          
          // Broadcast the end turn decision
          gameRoom.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'end_turn',
                team,
                reasoning: reasonings,
                timestamp: Date.now()
              }));
            }
          });
          
          break; // Exit the AI discussion loop
        }
      }
      
      // Skip old guess processing logic - we now handle guesses automatically after all agents have spoken once
      // Add a timeout or stuck detection to help move the game along if needed
      if (discussionRound > 3 && !votingTriggered) {
        console.log(`Discussion has gone on for ${discussionRound} rounds with no consensus. Ending turn.`);
        break;
      }
      
      // Calculate sortedWords if not already defined (in case voting wasn't triggered)
      let sortedWords = [];
      if (!votingTriggered) {
        // Collect all suggested words from all agents with their confidences
        const allSuggestions = discussions.flatMap(({ player, discussion }) => {
          const suggestedWords = Array.isArray(discussion.suggestedWords) && discussion.suggestedWords.length > 0
            ? discussion.suggestedWords
            : discussion.suggestedWord ? [discussion.suggestedWord] : [];
          
          const confidences = Array.isArray(discussion.confidences) && discussion.confidences.length > 0
            ? discussion.confidences
            : Array(suggestedWords.length).fill(discussion.confidence || 0.5);
          
          return suggestedWords.map((word, idx) => ({
            word,
            confidence: confidences[idx] || discussion.confidence || 0.5,
            player
          }));
        });
        
        // Group suggestions by word with aggregate confidence
        const wordConfidences = allSuggestions.reduce((acc, { word, confidence, player }) => {
          if (!acc[word]) {
            acc[word] = { totalConfidence: 0, supporters: new Set(), voters: [] };
          }
          acc[word].totalConfidence += confidence;
          acc[word].supporters.add(player);
          acc[word].voters.push({ player, confidence });
          return acc;
        }, {} as Record<string, { totalConfidence: number, supporters: Set<string>, voters: any[] }>);
        
        // Find the word with highest confidence across all agents
        sortedWords = Object.entries(wordConfidences)
          .sort(([_, a], [__, b]) => b.totalConfidence - a.totalConfidence)
          .map(([word, data]) => ({
            word,
            totalConfidence: data.totalConfidence,
            supporterCount: data.supporters.size,
            voters: data.voters
          }));
      }
      
      // Define qualified suggestions based on voting data
      const qualifiedSuggestions = sortedWords && sortedWords.length > 0 ? 
        [{
          word: sortedWords[0].word,
          confidence: sortedWords[0].totalConfidence
        }] : [];
        
      // Process suggestions and trigger guesses
      if (qualifiedSuggestions && qualifiedSuggestions.length > 0) {
        const suggestion = qualifiedSuggestions[0];
        console.log(`Team ${team} is making a guess: "${suggestion.word}"`);
        
        try {
          // Handle guess logic
          const result = await handleGuess(gameId, team, suggestion.word);
          guessCount++;
          
          // Update UI with guess result
          if (result === "wrong" || result === "assassin") {
            // Wrong guess ends the turn
            continueGuessing = false;
            break;
          } else if (result === "correct" && guessCount < maxGuesses) {
            // For correct guesses, prompt team to vote on whether to continue
            const voteMessage: TeamDiscussionEntry = {
              team: team as "red" | "blue",
              player: "claude-3-5-sonnet-20241022" as AIModel, // Use Claude as the mediator
              message: `Great job guessing "${suggestion.word}" correctly! Should we continue guessing or end our turn? We can make ${maxGuesses - guessCount} more guesses.`,
              confidences: [0.9],
              suggestedWords: [], // No words for meta vote message
              timestamp: Date.now(),
              round: discussionRound,
              isVoting: true, // Mark this as a voting message
              voteType: "continue" // Default to continue vote type
            };
            
            // Update game with voting message
            const updatedGame = await storage.getGame(gameId);
            if (updatedGame) {
              await storage.updateGame(gameId, {
                teamDiscussion: [
                  ...(updatedGame.teamDiscussion || []),
                  voteMessage
                ]
              });
            }
            
            // Broadcast voting message to clients
            gameRoom.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'discussion',
                  ...voteMessage,
                  isMetaDiscussion: true
                }));
              }
            });
            
            // Short pause to allow team to review the correct guess before continuing
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } catch (error) {
          console.error("Error processing guess:", error);
          continueGuessing = false;
        }
      }
      
      // If we've had a complete round of discussion, increment the round counter
      if (hasEveryoneSpokeThisRound) {
        discussionRound++;
        console.log(`📝 Moving to discussion round ${discussionRound}`);
      }
      
      // Add a short delay before next round of discussion messages
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check if we should force transition to voting after enough rounds
      if (discussionRound > 3 && !votingTriggered) {
        console.log(`🚨 After ${discussionRound-1} full rounds, forcing transition to voting phase`);
        votingTriggered = true;
        
        // Create a voting transition message
        const mediator = aiPlayers[0]; // Use first agent as moderator
        const suggestedWord = suggestion?.word || "";
        const confidence = suggestion?.confidence || 0.5;
        const votingMessage: TeamDiscussionEntry = {
          team: team as "red" | "blue",
          player: "Game", // Use "Game" for system messages
          message: `Should we guess "${suggestedWord}"?`,
          suggestedWord, // Make sure this is set
          suggestedWords: [suggestedWord], // Also include in the array for compatibility
          confidences: [confidence],
          timestamp: Date.now(),
          round: discussionRound,
          isVoting: true, // This is crucial - marks it as a voting message
          voteType: "continue" // Default vote type
        };
        
        // Update game with voting message
        await storage.updateGame(gameId, {
          teamDiscussion: [
            ...(game.teamDiscussion || []),
            votingMessage
          ]
        });
        
        // Broadcast voting message
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'discussion_updated',
              team,
              entry: votingMessage,
              voteStatus: {
                word: suggestedWord,
                votes: 0,
                threshold: Math.ceil(teamPlayers.length / 2),
                isVoting: true
              }
            }));
          }
        });
      }
    }
  } finally {
    gameRoom.aiDiscussionInProgress = false;
    console.log(`🏁 AI discussion for game ${gameId}, team ${team} complete after ${discussionRound-1} rounds`);
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
          .filter(d => d.team === team && d.player === model)
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
          team as "red" | "blue",
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
      const totalVoters = Math.max(1, teamAIPlayers.length + (currentTeamPlayers.includes('human') ? 1 : 0));
      const votePercentage = Math.round((voteCount / totalVoters) * 100);
      
      // Broadcast voting status to all clients
      const gameRoom = gameDiscussions.get(game.id);
      if (gameRoom) {
        console.log(`📊 Word votes status for "${word}": ${voteCount}/${totalVoters} (${votePercentage}%)`);
        
        // Send word_votes message to all clients
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'word_votes',
              team,
              words: [{
                word,
                votes: voteCount,
                percentage: votePercentage,
                voters: teamVotes.map(v => ({ player: v.player, confidence: v.confidence }))
              }],
              totalVoters,
              timestamp: Date.now()
            }));
          }
        });
      }

      // Check if we've reached consensus threshold to make a guess (>50%)
      const thresholdReached = votePercentage > 50;
      
      if (thresholdReached && team === (game.currentTurn === 'red_turn' ? 'red' : 'blue')) {
        console.log(`🎯 Consensus threshold reached for "${word}" with ${votePercentage}% of votes. Processing guess.`);
        
        // If threshold is reached, process the guess
        // Add the word to revealed cards
        const updatedRevealedCards = [...(game.revealedCards || []), word];
        
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
            gameState: team === "red" ? "blue_win" : "red_win"
          };
        } else if (result === "wrong") {
          // If wrong guess, switch turns
          turnUpdates = {
            currentTurn: game.currentTurn === "red_turn" ? "blue_turn" : "red_turn"
          };
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
      const totalVoters = teamAIPlayers.length;
      const votePercentage = Math.round((voteCount / Math.max(1, totalVoters)) * 100);
      
      // Broadcast meta vote status to all clients
      const gameRoom = gameDiscussions.get(game.id);
      if (gameRoom) {
        gameRoom.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'meta_vote',
              action,
              votes: voteCount,
              totalVoters,
              percentage: votePercentage,
              voters: actionVotes.map(v => ({ player: v.player, confidence: v.confidence || 0.8 })),
              team,
              timestamp: Date.now()
            }));
          }
        });
      }

      // Execute action when consensus is reached (>50% of voters)
      let shouldEndTurn = false;
      let shouldContinue = false;
      
      if (votePercentage > 50) {
        if (action === 'end_turn') {
          shouldEndTurn = true;
        } else if (action === 'continue') {
          shouldContinue = true;
        }
      }
      
      // Handle end turn action if consensus reached
      if (shouldEndTurn) {
        const nextTurn = team === 'red' ? "blue_turn" : "red_turn";
        await storage.updateGame(game.id, {
          currentTurn: nextTurn
        });
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