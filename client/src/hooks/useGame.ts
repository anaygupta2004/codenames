import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Game, TeamDiscussionEntry } from '@shared/schema';
import { queryClient } from '@/lib/queryClient';

export function useGame(gameId?: number) {
  console.log('🎮 useGame INITIALIZED:', { gameId });
  const [game, setGame] = useState<Game | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cleanupRef = useRef(false);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 3;
  // Generate a 5-digit player ID for each client
  const clientId = useRef(localStorage.getItem('clientId') || (() => {
    // Generate a 5-digit random number between 10000 and 99999
    const newId = Math.floor(10000 + Math.random() * 90000).toString();
    localStorage.setItem('clientId', newId);
    return newId;
  })());

  // Track processed message hashes to avoid duplicates
  const processedMessages = useRef(new Set<string>());

  // Create a hash function for message uniqueness
  // Make this less aggressive to avoid filtering out important messages
  const hashMessage = (msg: any): string => {
    if (!msg) return '';
    
    // Extract key fields to identify the message
    const timestamp = msg.timestamp || 0;
    const player = msg.player || '';
    const message = msg.message || msg.content || '';
    
    // Use a more comprehensive hash that includes parts of the message content
    // This will help distinguish between different messages from the same player at similar times
    return `${timestamp}-${player}-${message.slice(0, 10)}`;
  };

const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('⚠️ WebSocket already connected, skipping connection');
      return wsRef.current;
    }
    
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log('⚠️ WebSocket already connecting, skipping connection');
      return wsRef.current;
    }
    
    console.log('🔌 Creating new WebSocket connection...');
    
    // Use secure connection when appropriate
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      // Handle connection established
      ws.onopen = () => {
        console.log('🌐 WebSocket connected successfully');
        reconnectAttempts.current = 0;
        
        // Wait a tiny bit before sending join to ensure the socket is fully ready
        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              console.log('⬆️ Sending join message for game:', gameId);
              ws.send(JSON.stringify({ 
                type: 'join', 
                gameId,
                clientId: clientId.current
              }));
            } else {
              console.error('❌ Cannot send join message - WebSocket not open');
            }
          } catch (sendError) {
            console.error('❌ Error sending join message:', sendError);
          }
        }, 100);
      };
    
    ws.onclose = (event) => {
      console.log(`🔌 WebSocket disconnected: Code ${event.code}, clean: ${event.wasClean}`);
      
      // Only set to null if this is the current websocket
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      
      // Try to reconnect unless we're cleaning up or have tried too many times
      if (!cleanupRef.current && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts.current++;
        const timeout = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
        console.log(`🔄 Attempting to reconnect in ${timeout}ms... (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(connect, timeout);
      } else if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`❌ Maximum reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
      }
    };
    
    ws.onerror = (event) => {
      console.error('❌ WebSocket error:', event);
      
      // If we haven't sent the join message yet, try to reconnect immediately
      if (reconnectAttempts.current === 0) {
        console.log('🔄 Immediate reconnect after error');
        // Only null out if this is our current socket
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        // Try to reconnect with delay
        setTimeout(connect, 1000);
      }
    };
    return ws;
    } catch (connectionError) {
      console.error('❌ Error creating WebSocket connection:', connectionError);
      // Try again once after error
      setTimeout(() => {
        console.log('🔄 Retrying connection after error');
        // Only attempt if we haven't already got one
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connect();
        }
      }, 1000);
      return null;
    }
  }, [gameId, clientId]);

  useEffect(() => {
    if (cleanupRef.current) return;
    if (!gameId) return;

    const ws = connect();
    if (!ws) return;

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
        console.log('📥 WEBSOCKET MESSAGE RECEIVED:', {
          type: data.type,
          team: data.team,
          parsedData: data,
          currentGameState: game ? { id: game.id, discussionCount: game.teamDiscussion?.length } : null
        });
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data);
        return;
      }
      
      if (data.type === 'error') {
        console.error('Server error:', data.message);
        // Only mark the connection as dead if the error indicates the game is not active
        if (data.message === 'This game is no longer active.') {
          cleanupRef.current = true;
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
        }
        // Otherwise, leave reconnection logic to try again
        return;
      }

      // Handle server-initiated cleanup
      if (data.type === 'cleanup') {
        console.log('Received cleanup signal from server');
        cleanupRef.current = true;  // Set cleanup mode
        localStorage.clear();
        sessionStorage.clear();
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        window.location.reload();
        return;
      }

      if (data.type === 'reset') {
        // Clear local storage and close connection
        localStorage.removeItem('clientId');
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        // Generate new client ID for future
        clientId.current = Math.random().toString(36).substring(7);
        localStorage.setItem('clientId', clientId.current);
        return;
      }
      
      // Handle discussion cleared event
      if (data.type === 'discussion_cleared') {
        console.log(`🧹 Discussion cleared for team ${data.team}`);
        
        // Clear local discussion state for this team
        setGame(prev => {
          if (!prev) return prev;
          
          // Filter out all messages from this team that aren't turn change messages
          const filteredDiscussion = (prev.teamDiscussion || []).filter(msg => 
            msg.team !== data.team || msg.isTurnChange === true
          );
          
          // Reset all voting state
          const filteredConsensusVotes = (prev.consensusVotes || []).filter(v => 
            v.team !== data.team
          );
          
          const filteredMetaVotes = (prev.metaVotes || []).filter(v => 
            v.team !== data.team
          );
          
          return {
            ...prev,
            teamDiscussion: filteredDiscussion,
            consensusVotes: filteredConsensusVotes,
            metaVotes: filteredMetaVotes
          };
        });
        
        // Clear the processed messages cache too
        processedMessages.current = new Set();
        
        // Force refresh game data
        queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${gameId}`],
          refetchType: 'active'
        });
        
        return;
      }

      if (data.type === 'discussion' || data.type === 'guess' || data.type === 'word_votes' || data.type === 'meta_vote' || data.type === 'turn_change') {
        console.log('💬 Received message:', {
          type: data.type,
          team: data.team,
          player: data.player,
          content: data.content?.substring(0, 30) + '...',
          hasTimeInfo: !!data.timeInfo,
          hasVoting: data.isVoting,
          voteType: data.voteType,
          messageCount: game?.teamDiscussion?.length
        });
        
        // CRITICAL: Force an immediate refresh of the game data
        queryClient.invalidateQueries({ 
          queryKey: [`/api/games/${gameId}`],
          refetchType: 'active' 
        });

        setGame(prev => {
          console.log('💫 UPDATING GAME STATE:', {
            previousState: prev ? { id: prev.id, messageCount: prev.teamDiscussion?.length } : null,
            newMessage: { type: data.type, player: data.player }
          });

          if (!prev) {
            console.log('❌ No previous game state');
            return prev;
          }

          // Start with the base game state
          const newState = { ...prev };
          
          // Handle different message types
          if (data.type === 'discussion') {
            // Create a new discussion entry - ensure all fields are properly mapped
            const newEntry: TeamDiscussionEntry = {
              team: data.team,
              player: data.player,
              message: data.content || data.message || '', // Support both content and message fields
              confidences: data.confidences || [data.confidence || 0.5],
              suggestedWords: data.suggestedWords || [],
              timestamp: data.timestamp,
              isVoting: Boolean(data.isVoting),
              voteType: data.voteType || '',
              timeInfo: data.timeInfo
            };
            
            // Always ensure we have proper arrays for suggestedWords and confidences
            if (!newEntry.suggestedWords) {
              newEntry.suggestedWords = [];
            }
            
            // If old-style suggestedWord is present, convert to array format
            if (data.suggestedWord && (!newEntry.suggestedWords || newEntry.suggestedWords.length === 0)) {
              newEntry.suggestedWords = [data.suggestedWord];
            }
            
            // Ensure confidences array matches suggestedWords length
            if (newEntry.suggestedWords.length > 0 && 
                (!newEntry.confidences || newEntry.confidences.length < newEntry.suggestedWords.length)) {
              
              // Create a confidences array that matches the length of suggestedWords
              const baseConfidence = data.confidence || 0.7;
              newEntry.confidences = newEntry.suggestedWords.map((_, idx) => {
                // Scale confidence down for each subsequent word
                return Math.max(0.3, baseConfidence * (1 - idx * 0.15));
              });
            }
            
            // For debugging - log the actual message content
            console.log(`📨 Message from ${data.player}: ${newEntry.message}`);
            console.log(`Has suggested words: ${Boolean(newEntry.suggestedWords && newEntry.suggestedWords.length > 0)}`);
            if (newEntry.suggestedWords.length > 0) {
              console.log(`Words: ${newEntry.suggestedWords.join(', ')}`);
              console.log(`Confidences: ${newEntry.confidences?.join(', ')}`);
            }
            
            // IMPORTANT: Do not filter out messages, always add them
            // We'll just use a better hash function to detect true duplicates
            const messageHash = hashMessage(newEntry);
            let isDuplicate = messageHash && processedMessages.current.has(messageHash);
            
            if (isDuplicate) {
              console.log(`⚠️ Possible duplicate detected with hash ${messageHash}`);
              // If hash matches, but it has voting information, keep it anyway
              if (newEntry.isVoting || newEntry.suggestedWords.length > 0) {
                console.log(`🔄 Message has voting/suggestion data, adding anyway`);
                isDuplicate = false;
              }
            }
            
            // Only track actual duplicates by hash
            if (!isDuplicate && messageHash) {
              processedMessages.current.add(messageHash);
            }
            
            // CRITICAL: Do not drop messages with suggestions or voting
            // Better to have duplicates than miss important messages
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              newEntry
            ];
            
            console.log(`✅ Added message from ${newEntry.player}, isVoting: ${newEntry.isVoting}, suggestedWords: ${newEntry.suggestedWords.length}, type: ${newEntry.voteType}`);
            
            // IMPORTANT: Force a cache update to ensure React Query pulls the new message
            // This ensures messages appear in both TeamDiscussion and useGame state
            queryClient.invalidateQueries({ 
              queryKey: [`/api/games/${gameId}`],
              refetchType: 'active' 
            });
          } 
          else if (data.type === 'guess') {
            console.log(`🎲 Received guess event: ${data.word} - ${data.result}`);
            
            // Add guess to discussion
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              {
                team: data.team,
                player: 'Game' as const,
                message: `Guessed: ${data.content || data.word}`,
                confidences: [1],
                suggestedWords: [data.content || data.word],
                timestamp: data.timestamp
              }
            ];
            
            // Update revealed cards
            const guessedWord = data.content || data.word;
            newState.revealedCards = [...(prev.revealedCards || [])];
            
            // Only add if not already revealed
            if (guessedWord && !newState.revealedCards.includes(guessedWord)) {
              newState.revealedCards.push(guessedWord);
            }
            
            // ENHANCED: For correct guesses, immediately add a meta decision
            if (data.result === 'correct') {
              console.log(`✅ CORRECT GUESS DETECTED - AUTO-CREATING META DECISION`);
              
              // Create a unique meta decision ID that includes the guess word to prevent duplicates
              const metaDecisionId = `meta-${data.team}-${data.word || data.content}-${data.timestamp || Date.now()}`;
              
              // Store this ID in localStorage to prevent duplicate meta decisions
              const existingDecisions = JSON.parse(localStorage.getItem('recentMetaDecisions') || '[]');
              
              // More strict check for duplicate meta decisions - consider a decision a duplicate if:
              // 1. It's for the same team AND
              // 2. It's within the last 20 seconds AND
              // 3. There's already ANY meta decision poll for this team
              const isDuplicate = existingDecisions.some((decision: any) => 
                // Same team
                decision.team === data.team && 
                // Recent - increased from 10s to 20s for better deduplication
                (Date.now() - decision.timestamp < 20000)
              );
              
              // Extra safety check: also mark as duplicate if there's already a meta decision in the discussion
              const hasExistingMetaDecision = prev.teamDiscussion?.some(msg => 
                msg.team === data.team && 
                msg.isVoting === true && 
                msg.voteType === 'meta_decision' &&
                // Only consider recent meta decisions (within the last 30 seconds)
                (Date.now() - (msg.timestamp || 0)) < 30000
              );
              
              if (hasExistingMetaDecision) {
                console.log(`⚠️ Active meta decision already exists for team ${data.team} - skipping duplicate`);
              }
              
              if (!isDuplicate && !hasExistingMetaDecision) {
                // Track this decision to prevent duplicates
                existingDecisions.push({
                  id: metaDecisionId,
                  team: data.team,
                  word: data.word || data.content,
                  timestamp: Date.now()
                });
                
                // Keep only the 5 most recent decisions
                if (existingDecisions.length > 5) {
                  existingDecisions.shift();
                }
                
                localStorage.setItem('recentMetaDecisions', JSON.stringify(existingDecisions));
                
                // Create meta decision message
                const metaDecisionMsg = {
                  team: data.team,
                  player: 'Game' as const,
                  message: "Team must decide: continue guessing or end turn?",
                  timestamp: (data.timestamp || Date.now()) + 100, // Ensure it appears after the guess
                  isVoting: true,
                  voteType: 'meta_decision',
                  metaOptions: ['continue', 'end_turn'],
                  pollId: metaDecisionId // Use consistent ID to prevent duplicates
                };
                
                // Add the meta decision to the discussion
                newState.teamDiscussion.push(metaDecisionMsg);
                
                // Request AI models to participate
                setTimeout(() => {
                  fetch(`/api/games/${prev.id}/meta/discuss`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      message: "Should we continue guessing or end turn?",
                      team: data.team,
                      triggerVoting: true,
                      isVoting: true,
                      voteType: 'meta_decision',
                      forceMeta: true,
                      pollId: metaDecisionId // Include consistent poll ID
                    })
                  }).catch(err => console.error("Error creating meta decision after correct guess:", err));
                }, 300);
              } else {
                console.log(`⚠️ Skipping duplicate meta decision for team ${data.team}`);
              }
            }
          }
          else if (data.type === 'word_votes') {
            console.log('💠 Processing word votes:', data);
            // Make sure the data is properly structured
            if (data.words && Array.isArray(data.words)) {
              // Store word votes in consensusVotes
              const newVotes = data.words.flatMap(wordData => {
                if (!wordData || !wordData.voters || !Array.isArray(wordData.voters)) {
                  console.warn('Invalid word vote data:', wordData);
                  return [];
                }
                return wordData.voters.map(voter => ({
                  team: data.team,
                  player: voter.player,
                  word: wordData.word,
                  approved: true,
                  confidence: voter.confidence || 0.5,
                  timestamp: data.timestamp || Date.now()
                }));
              });
              
              // Append new votes to existing ones with deduplication
              const existingVotes = prev.consensusVotes || [];
              const voteMap = new Map();
              
              // Index existing votes
              existingVotes.forEach(vote => {
                voteMap.set(`${vote.player}-${vote.word}`, vote);
              });
              
              // Add or update with new votes
              newVotes.forEach(vote => {
                voteMap.set(`${vote.player}-${vote.word}`, vote);
              });
              
              newState.consensusVotes = Array.from(voteMap.values());
              console.log('Updated consensus votes:', newState.consensusVotes);
            }
          }
          else if (data.type === 'meta_vote') {
            console.log('💠 Processing meta vote:', data);
            if (data.voters && Array.isArray(data.voters)) {
              // Store meta votes with deduplication
              const existingVotes = prev.metaVotes || [];
              const voteMap = new Map();
              
              // Index existing votes
              existingVotes.forEach(vote => {
                voteMap.set(`${vote.player}-${vote.action}`, vote);
              });
              
              // Add new votes
              data.voters.forEach(voter => {
                const newVote = {
                  team: data.team,
                  player: voter.player,
                  action: data.action,
                  timestamp: data.timestamp || Date.now(),
                  confidence: voter.confidence || 0.5,
                  reasoning: voter.reasoning || "",
                  pollId: data.pollId, // Ensure pollId is included
                  messageId: data.messageId, // Add messageId for more reliable matching
                  baseModel: voter.baseModel || voter.player // Include base model for icon display
                };
                // CRITICAL FIX: Handle unique model IDs correctly
                // Extract base model for proper deduplication
                let baseModelPlayer = voter.player;
                
                // Extract base model from any format
                if (typeof baseModelPlayer === 'string') {
                  if (baseModelPlayer.includes('#')) {
                    baseModelPlayer = baseModelPlayer.split('#')[0];
                  } else if (baseModelPlayer.includes('-')) {
                    const possibleModels = ['gpt-4o', 'claude-sonnet-4-5-20250929', 'grok-4-fast-reasoning', 'gemini-1.5-pro', 'llama-7b'];
                    for (const model of possibleModels) {
                      if (baseModelPlayer.startsWith(model)) {
                        baseModelPlayer = model;
                        break;
                      }
                    }
                  }
                }
                
                // Use base model name for deduplication in the vote map
                voteMap.set(`${baseModelPlayer}-${data.action}`, newVote);
                
                // Add each meta vote to game history with player reasoning
                const playerName = typeof voter.player === 'string' && voter.player.includes('#') 
                  ? voter.player.split('#')[0] 
                  : voter.player;
                
                // Add meta vote entry to game history with enhanced fields to ensure it's displayed
                const historyEntry = {
                  type: "meta_vote",
                  turn: data.team,
                  content: `${playerName} voted to ${data.action === 'continue' ? 'continue guessing' : 'end turn'}`,
                  timestamp: data.timestamp || Date.now(),
                  reasoning: voter.reasoning || "",
                  player: voter.player,
                  word: data.action, // Store the action in the word field for rendering
                  voteAction: data.action
                };
                
                console.log("✅ Adding meta vote to game history:", historyEntry);
                
                // Add to game history
                if (!newState.gameHistory) {
                  newState.gameHistory = [];
                }
                
                // Check if this entry is a duplicate before adding
                const isDuplicate = newState.gameHistory.some(entry => 
                  entry.type === "meta_vote" && 
                  entry.player === voter.player &&
                  entry.voteAction === data.action &&
                  Math.abs((entry.timestamp || 0) - (data.timestamp || Date.now())) < 5000 // Within 5 seconds
                );
                
                if (!isDuplicate) {
                  newState.gameHistory.push(historyEntry);
                }
              });
              
              newState.metaVotes = Array.from(voteMap.values());
              console.log('Updated meta votes:', newState.metaVotes);
            }
          }
          else if (data.type === 'turn_change') {
            console.log('🔄 Processing turn change:', data);
            
            // CRITICAL: Reset the game's turn state immediately
            newState.currentTurn = data.to === 'red' ? 'red_turn' : 'blue_turn';
            
            // Reset the turn timer by updating current start time
            // THIS IS CRITICAL for proper timer function
            newState.currentTurnStartTime = new Date();
            
            // Get detailed reason with word information if available
            let reasonText = data.reason || '';
            if (data.word) {
              reasonText += ` (word: ${data.word})`;
            }
            if (data.highPriority || data.forced) {
              reasonText += ' [forced]';
            }
            
            // Create a richer message with reason if available
            const message = `Turn ended${reasonText ? ` (${reasonText})` : ''}. ${data.to.toUpperCase()} team's turn now.`;
            
            // Add a prominent notification message to the discussion
            newState.teamDiscussion = [
              ...(prev.teamDiscussion || []),
              {
                team: data.from,
                player: 'Game' as const,
                message: message,
                confidences: [1],
                suggestedWords: [],
                timestamp: data.timestamp || Date.now(),
                // Special flag for turn change messages
                isTurnChange: true,
                // Mark as high priority for forced turn changes
                highPriority: data.highPriority || data.forced || data.reason === 'time_expired'
              }
            ];
            
            // Also add message to other team's discussion for ALL turn changes
            // This ensures both teams are aware of turn changes
            newState.teamDiscussion.push({
              team: data.to,
              player: 'Game' as const,
              message: `${data.from.toUpperCase()} team's turn ended${reasonText ? ` (${reasonText})` : ''}. It's your turn now!`,
              confidences: [1],
              suggestedWords: [],
              timestamp: (data.timestamp || Date.now()) + 1,
              // Special flags for turn change messages
              isTurnChange: true, 
              isTurnStart: true,
              highPriority: data.highPriority || data.forced || data.reason === 'time_expired'
            });
            
            // CRITICAL: We need to ensure we maintain any pending meta decisions
            // while clearing old meta votes that are no longer relevant
            console.log('🔄 TURN CHANGE - Selectively resetting meta votes');
            
            // IMPROVED: Only clear votes for the team whose turn is ending
            // This prevents interrupting ongoing meta decisions and ensures they get resolved
            console.log(`🧹 Selective poll reset - only clearing polls for team ${data.from}`);
            
            // Get any active meta polls for the team whose turn is starting
            const activeMetaPolls = Array.isArray(prev.metaVotes) 
              ? prev.metaVotes.filter(vote => 
                  // Keep votes for the team whose turn is starting
                  vote.team === data.to &&
                  // Only keep votes that are from the last 60 seconds (active decisions)
                  (Date.now() - (vote.timestamp || 0)) < 60000
                )
              : [];
              
            // Keep any active meta votes for the team whose turn is starting
            // but clear votes for the team whose turn is ending
            newState.metaVotes = activeMetaPolls;
            
            console.log(`🔍 Keeping ${activeMetaPolls.length} active meta votes for team ${data.to}`);
            
            // Reset consensus votes to prevent old votes from affecting new turns
            // This ensures complete poll individualization between turns too
            newState.consensusVotes = prev.consensusVotes?.filter(vote => vote.team === data.to) || [];
            
            // Process in voting component - but keep messages for the incoming team
            processedMessages.current = new Set();
            
            // Store the change in localStorage to help other components be aware
            localStorage.setItem('lastTurnChange', Date.now().toString());
            localStorage.setItem('currentTurn', data.to);
            
            // Log the turn change and state updates
            console.log(`Turn changed from ${data.from} to ${data.to}. ALL polls have been reset.`);
          }

          console.log('📝 New state after update:', {
            type: data.type,
            messageCount: newState.teamDiscussion?.length,
            voteCount: newState.consensusVotes?.length,
            metaVoteCount: newState.metaVotes?.length
          });

          return newState;
        });
      }
    };

    return () => {
      cleanupRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [gameId, connect]);

  // Initial game fetch
  useEffect(() => {
    if (!gameId) return;
    
    async function fetchInitialGame() {
      try {
        console.log('🎯 Fetching initial game state');
        const res = await fetch(`/api/games/${gameId}`);
        if (!res.ok) throw new Error('Failed to fetch game');
        const initialGame = await res.json();
        console.log('✨ Initial game state:', {
          hasDiscussion: !!initialGame.teamDiscussion,
          discussionCount: initialGame.teamDiscussion?.length
        });
        setGame(initialGame);
      } catch (error) {
        console.error('Initial fetch error:', error);
      }
    }
    
    fetchInitialGame();
  }, [gameId]);

  // Polling for updates
  useEffect(() => {
    if (!gameId) return;
    
    console.log('🔄 Starting game polling');
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/games/${gameId}`);
        if (!res.ok) throw new Error('Failed to fetch game');
        const latestGame = await res.json();
        
        console.log('📥 Poll received:', {
          hasDiscussion: !!latestGame.teamDiscussion,
          messageCount: latestGame.teamDiscussion?.length,
          messages: latestGame.teamDiscussion
        });
        
        setGame(prev => {
          console.log('🔄 Merging game states:', {
            prevCount: prev?.teamDiscussion?.length || 0,
            newCount: latestGame.teamDiscussion?.length || 0
          });

          if (!prev) return latestGame;
          
          // Merge discussions to avoid duplicates
          const allDiscussions = [
            ...(prev.teamDiscussion || []),
            ...(latestGame.teamDiscussion || [])
          ];
          
          // Merge discussions to avoid duplicates using our hash function
          const messageMap = new Map();
          
          allDiscussions.forEach(msg => {
            const key = hashMessage(msg);
            if (key) {
              messageMap.set(key, msg);
            }
          });
          
          const uniqueDiscussions = Array.from(messageMap.values())
            .sort((a, b) => a.timestamp - b.timestamp);

          console.log('✨ Merged discussions:', {
            totalMessages: allDiscussions.length,
            uniqueMessages: uniqueDiscussions.length
          });

          return {
            ...latestGame,
            teamDiscussion: uniqueDiscussions
          };
        });
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 2000); // Poll every 2 seconds
    
    return () => clearInterval(pollInterval);
  }, [gameId]);

  // Add a helper function to merge discussion arrays without duplicates.
  function mergeDiscussion(
    latest: any[] = [], 
    prev: any[] = []
  ): any[] {
    const all = [...prev, ...latest];
    const unique = new Map();
    
    all.forEach(msg => {
      // Use our universal hash function
      const key = hashMessage(msg);
      if (key && !unique.has(key)) {
        unique.set(key, msg);
      }
    });
    
    // Sort by timestamp (ascending)
    return Array.from(unique.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  // Debug: Log every game state change
  useEffect(() => {
    console.log('🎲 Game state changed:', {
      hasGame: !!game,
      gameId: game?.id,
      discussionCount: game?.teamDiscussion?.length,
      messages: game?.teamDiscussion
    });
  }, [game]);

  // Helper function to find the active poll ID for a team
  const getActiveMetaPollId = useCallback((teamColor: 'red' | 'blue') => {
    if (!game || !game.teamDiscussion) return null;
    
    // Find the most recent meta decision poll for this team
    const metaDecisions = game.teamDiscussion
      .filter(entry => 
        entry.team === teamColor && 
        entry.isVoting === true && 
        entry.voteType === 'meta_decision'
      )
      .sort((a, b) => b.timestamp - a.timestamp);
    
    // If we found a meta decision, return its pollId or generate one
    if (metaDecisions.length > 0) {
      const latestPoll = metaDecisions[0];
      
      // Return the pollId if it exists
      if (latestPoll.pollId) {
        console.log(`🔍 Found active poll ID: ${latestPoll.pollId} for team ${teamColor}`);
        return latestPoll.pollId;
      }
      
      // Generate a stable pollId based on the entry
      const messageFragment = latestPoll.message?.substring(0, 10) || '';
      const generatedPollId = `meta-${teamColor}-${latestPoll.timestamp}-${latestPoll.player}-${messageFragment}`;
      console.log(`🔧 Generated poll ID: ${generatedPollId} for team ${teamColor}`);
      return generatedPollId;
    }
    
    // No active poll found
    console.log(`⚠️ No active poll found for team ${teamColor}`);
    return null;
  }, [game]);

  return { game, clientId, wsRef, getActiveMetaPollId };
} 